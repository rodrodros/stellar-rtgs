// The simulation's view of the RTGS: the session's store plus each bank's trustline. The store
// follows the contract's events and re-reads the banks they touch, so balances, queues, repos
// and credit come from its snapshot; the cash token's trustlines are not in it, so the world
// reads them itself, at start and whenever an action says it touched them. Every read of the
// view is synchronous, because actions and the policy plan many times a tick.
import { RtgsError } from "@rtgs/core";
import type { Capabilities, Config, Holding, Payment, Repo, RtgsSession, RtgsStore, SystemSnapshot } from "@rtgs/core";
import type { BankState, World } from "../types.ts";

export interface WorldOptions {
  /** How long `start` waits for the store's first load before giving up. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;

type Trustline = Pick<Holding, "balance" | "authorized">;

/**
 * A world over `session`'s shared store, for `banks` (the bootstrap's `bank-1..N`, in the order
 * the simulation lists them). The central bank and the contract are not banks.
 */
export function createWorld(
  session: RtgsSession,
  banks: readonly { address: string; label: string }[],
  options: WorldOptions = {},
): World {
  const labels = new Map(banks.map((b) => [b.address, b.label]));
  const trustlines = new Map<string, Trustline>();
  /** Bumped by every trustline read, so the cached bank list knows to rebuild. */
  let trustlinesVersion = 0;
  /** The newest read started per address: an older read that resolves later is dropped. */
  const readSeq = new Map<string, number>();
  let seq = 0;

  let held: { store: RtgsStore; release: () => void; unsubscribe: () => void } | undefined;
  let stopped = false;
  /** Ends a `start()` still waiting for the store, so `stop()` doesn't leave it hanging. */
  let abortWait: ((error: RtgsError) => void) | undefined;

  // The local clock's lead over ledger close time, as small as ever observed (as in core's
  // `useLedgerClock`): taking the minimum keeps `now()` from stepping back when a later ledger
  // is reported with more lag.
  let clockLead: number | undefined;
  let seenLedger: SystemSnapshot["ledger"];
  const observeLedger = (snapshot: SystemSnapshot) => {
    const ledger = snapshot.ledger;
    if (!ledger || ledger === seenLedger) return;
    seenLedger = ledger;
    const lead = Date.now() / 1000 - ledger.closeTime;
    if (clockLead === undefined || lead < clockLead) clockLead = lead;
  };

  const snapshot = (): SystemSnapshot => {
    if (!held) throw new RtgsError("config", "World not started", "Call world.start() before reading the world.");
    return held.store.getSnapshot();
  };

  // `banks()` is read many times a tick: the mapped list is rebuilt only when what it is built
  // from changes. The store replaces these maps rather than mutating them.
  let cache:
    | {
        banks: SystemSnapshot["banks"];
        payments: SystemSnapshot["payments"];
        collateral: SystemSnapshot["collateral"];
        trustlinesVersion: number;
        list: readonly BankState[];
        byAddress: Map<string, BankState>;
      }
    | undefined;

  const mapped = () => {
    const s = snapshot();
    if (
      cache &&
      cache.banks === s.banks &&
      cache.payments === s.payments &&
      cache.collateral === s.collateral &&
      cache.trustlinesVersion === trustlinesVersion
    ) {
      return cache;
    }
    // The bank views are re-read a moment after the events that change them; until then, drop
    // the payment orders the events already show as settled, revoked or expired, and put a
    // reprioritised one in its new class (by age, as the contract keeps it).
    const queuesOf = (view: { queues: BankState["queues"] }): BankState["queues"] => {
      const queues: BankState["queues"] = { urgent: [], normal: [] };
      let moved = false;
      for (const p of [...view.queues.urgent, ...view.queues.normal]) {
        const record = s.payments.get(p.id);
        if (record && record.status !== "queued") continue;
        const priority = record?.priority ?? p.priority;
        const inView = view.queues[priority].includes(p);
        moved ||= !inView;
        queues[priority].push(inView ? p : { ...p, priority });
      }
      if (moved) {
        queues.urgent.sort(byId);
        queues.normal.sort(byId);
      }
      return queues;
    };
    const list: BankState[] = [];
    for (const { address, label } of banks) {
      const view = s.banks.get(address);
      // Not read yet (it isn't in the registry, or its read failed): leave it out rather than
      // plan against a made-up zero balance.
      if (!view) continue;
      const trustline = trustlines.get(address);
      const state: BankState = {
        address,
        label,
        balance: view.balance,
        holding: trustline?.balance ?? 0n,
        authorized: trustline?.authorized ?? false,
        queues: queuesOf(view),
      };
      if (view.credit) state.credit = view.credit;
      const collateral = s.collateral.get(address);
      if (collateral !== undefined) state.collateral = collateral;
      list.push(state);
    }
    cache = {
      banks: s.banks,
      payments: s.payments,
      collateral: s.collateral,
      trustlinesVersion,
      list,
      byAddress: new Map(list.map((b) => [b.address, b])),
    };
    return cache;
  };

  /** Reads these banks' trustlines in parallel; a read overtaken by a newer one is dropped. */
  const readTrustlines = async (addresses: readonly string[]): Promise<void> => {
    await Promise.all(
      [...new Set(addresses)].map(async (address) => {
        const mine = ++seq;
        readSeq.set(address, mine);
        const holding = await session.token.holding(address);
        if (stopped || readSeq.get(address) !== mine) return;
        trustlines.set(address, { balance: holding.balance, authorized: holding.authorized });
        trustlinesVersion += 1;
      }),
    );
  };

  const waitReady = (store: RtgsStore): Promise<void> => {
    const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const settle = (error?: unknown) => {
        if (timer) clearTimeout(timer);
        unsubscribe();
        abortWait = undefined;
        if (error) reject(error);
        else resolve();
      };
      abortWait = settle;
      const check = () => {
        if (store.getSnapshot().status === "ready") settle();
      };
      unsubscribe = store.subscribe(check);
      // The store retries a failed load by itself, so an error is only final at the deadline;
      // then it is the reason, else the wait itself is.
      timer = setTimeout(() => {
        const { error } = store.getSnapshot();
        settle(error ?? new RtgsError("rpc", "World not ready", `The store's first load took more than ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      check();
    });
  };

  const stop = () => {
    stopped = true;
    abortWait?.(new RtgsError("config", "World stopped", "The world was stopped before the store was ready."));
    if (!held) return;
    const { release, unsubscribe } = held;
    held = undefined;
    unsubscribe();
    release();
  };

  return {
    centralBank: session.centralBank,
    contractId: session.contractId,

    async start() {
      if (held) throw new RtgsError("config", "World already started", "Start a world once; stop() it before starting it again.");
      stopped = false;
      const { store, release } = session.store();
      const unsubscribe = store.subscribe(() => observeLedger(store.getSnapshot()));
      held = { store, release, unsubscribe };
      try {
        await waitReady(store);
        observeLedger(store.getSnapshot());
        await readTrustlines(banks.map((b) => b.address));
        if (stopped) throw new RtgsError("config", "World stopped", "The world was stopped while it was starting.");
      } catch (e) {
        stop();
        throw e;
      }
    },

    async refresh(addresses) {
      if (!held) return;
      await readTrustlines(addresses.filter((a) => labels.has(a)));
    },

    stop,

    now() {
      const ledger = snapshot().ledger;
      if (!ledger || clockLead === undefined) {
        throw new RtgsError("config", "No ledger yet", "The store hasn't seen a ledger; wait for world.start().");
      }
      return Math.max(ledger.closeTime, Math.floor(Date.now() / 1000 - clockLead));
    },

    config(): Config {
      const config = snapshot().config;
      if (!config) throw new RtgsError("config", "No config yet", "The contract's config hasn't been read; wait for world.start().");
      return config;
    },

    capabilities(): Capabilities {
      return snapshot().capabilities;
    },

    queuedCount() {
      return snapshot().queuedCount;
    },

    banks() {
      return mapped().list;
    },

    bank(address) {
      return mapped().byAddress.get(address);
    },

    queuedPayments(from) {
      const sources = from === undefined ? mapped().list : [mapped().byAddress.get(from)].filter((b) => b !== undefined);
      return sources.flatMap((b) => [...b.queues.urgent, ...b.queues.normal]).sort(byId);
    },

    repos(bank) {
      return [...snapshot().repos.values()].filter((r) => r.status !== "repaid" && (bank === undefined || r.bank === bank)).sort(byId);
    },
  };
}

function byId(a: Payment | Repo, b: Payment | Repo): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
