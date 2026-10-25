// A fake core session and store for component tests: the shapes the app reads from
// @rtgs/core, with every write a spy. No network.
import {
  allAvailable,
  analyseQueues,
  loadNetworks,
  type Bank,
  type BankView,
  type Capabilities,
  type Config,
  type Holding,
  type Payment,
  type PaymentRecord,
  type Repo,
  type RtgsSession,
  type Signer,
  type SystemSnapshot,
} from "@rtgs/core";
import { RtgsProvider } from "@rtgs/core/react";
import { render, screen } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { vi } from "vitest";
import { AutoKeeperProvider } from "../keeper/AutoKeeperProvider.tsx";
import { AppSessionContext, type AppSession } from "../session/AppSession.tsx";

export const CB = "GCENTRALBANKXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
export const CONTRACT = "CSETTLEMENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
export const SAC = "CSACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
export const BANK_A = "GBANKAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
export const BANK_B = "GBANKBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
export const OTHER = "GOTHERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

export const CONFIG: Config = { queueCap: 16, expirySecs: 100, repoTermSecs: 1000, penaltyRateBps: 500 };
export const NOW = 10_000;

const devnet = loadNetworks({})[0]!;

export function signer(address: string): Signer {
  return { kind: "devnet-keypair", address, networkPassphrase: devnet.passphrase, signTransaction: async (x) => x };
}

const outcome = { txHash: "ab".repeat(32), ledger: 77, closedAt: NOW, value: undefined, events: [] };

export function payment(id: bigint, from: string, to: string, amount: bigint, extra: Partial<Payment> = {}): Payment {
  return { id, from, to, amount, priority: "normal", submittedAt: NOW - 50, status: "queued", ...extra };
}

export function bankView(address: string, name: string, balance: bigint, queues: { urgent?: Payment[]; normal?: Payment[] } = {}): BankView {
  const q = { urgent: queues.urgent ?? [], normal: queues.normal ?? [] };
  return { address, name, balance, queues: q, analysis: analyseQueues(balance, q, CONFIG) };
}

export interface FakeOptions {
  /** Extra registry entries, e.g. one core should never list. */
  extraRegistry?: Bank[];
  capabilities?: Partial<Capabilities>;
  banks?: BankView[];
  payments?: Payment[];
  repos?: Repo[];
  holdings?: Record<string, Partial<Holding>>;
  /** The settlement contract's own SAC holding. */
  contractHolding?: Partial<Holding>;
  snapshot?: Partial<SystemSnapshot>;
}

export function fakeSession(opts: FakeOptions = {}) {
  const banks = opts.banks ?? [bankView(BANK_A, "Bank A", 500n), bankView(BANK_B, "Bank B", 100n)];
  const registry: Bank[] = [
    ...banks.map((b): Bank => ({ address: b.address, ...(b.name ? { name: b.name } : {}), sources: ["ledger"] })),
    ...(opts.extraRegistry ?? []),
  ];
  const capabilities = { ...allAvailable(), ...opts.capabilities } as Capabilities;
  const holding = (h: Partial<Holding> = {}): Holding => ({
    balance: 0n,
    exists: true,
    authorized: true,
    authorizedToMaintainLiabilities: false,
    clawbackEnabled: true,
    ...h,
  });
  const contractHolding = holding({ balance: banks.reduce((s, b) => s + b.balance, 0n), ...opts.contractHolding });

  const actor = {
    expire: vi.fn(async () => outcome),
    convertOverdue: vi.fn(async () => outcome),
    setCollateral: vi.fn(async () => outcome),
    openRepo: vi.fn(async () => ({ ...outcome, value: { repoId: 0n } })),
    repay: vi.fn(async () => outcome),
  };
  const tokenAdmin = {
    authorize: vi.fn(async () => outcome),
    issue: vi.fn(async () => outcome),
    clawback: vi.fn(async () => outcome),
  };
  const registryApi = {
    list: () => registry,
    get: (a: string) => registry.find((b) => b.address === a),
    nameOf: (a: string) => (a === CB ? "Central bank" : (registry.find((b) => b.address === a)?.name ?? a.slice(0, 4))),
    register: vi.fn(async () => outcome),
    unregister: vi.fn(async () => outcome),
    subscribe: () => () => {},
  };

  const payments = new Map<bigint, PaymentRecord>();
  for (const p of opts.payments ?? []) payments.set(p.id, { ...p, steps: [] });
  for (const b of banks) for (const p of [...b.queues.urgent, ...b.queues.normal]) payments.set(p.id, { ...p, steps: [] });

  const snapshot: SystemSnapshot = {
    status: "ready",
    contractId: CONTRACT,
    centralBank: CB,
    capabilities,
    config: CONFIG,
    queuedCount: [...payments.values()].filter((p) => p.status === "queued").length,
    banks: new Map(banks.map((b) => [b.address, b])),
    payments,
    repos: new Map((opts.repos ?? []).map((r) => [r.id, r])),
    collateral: new Map(),
    events: [],
    registry,
    feed: { state: "live", clamped: false },
    ledger: { sequence: 100, closeTime: NOW },
    ...opts.snapshot,
  };
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {} };

  const session = {
    network: devnet,
    contractId: CONTRACT,
    centralBank: CB,
    cashToken: { sacId: SAC, code: "USD", issuer: CB },
    capabilities,
    registry: registryApi,
    token: {
      holding: vi.fn(async (a: string) => (a === CONTRACT ? contractHolding : holding(opts.holdings?.[a]))),
    },
    read: { balance: vi.fn(async (a: string) => banks.find((b) => b.address === a)?.balance ?? 0n) },
    as: vi.fn(() => actor),
    tokenAdmin: vi.fn((s: Signer) => {
      if (s.address !== CB) throw new Error("not the token admin");
      return tokenAdmin;
    }),
    store: () => ({ store, release: () => {} }),
  };
  return { session: session as unknown as RtgsSession, actor, tokenAdmin, registry: registryApi, snapshot };
}

/**
 * Renders `ui` inside a connected app, signed by `as` (the central bank by default; null for no
 * signer). `strict` renders under StrictMode, as `pnpm dev` does.
 */
export function renderConnected(ui: ReactNode, fake = fakeSession(), as: string | null = CB, opts: RenderOptions = {}) {
  return { ...fake, ...render(renderConnected.tree(ui, fake, as, opts)) };
}

interface RenderOptions {
  strict?: boolean;
  app?: Partial<AppSession>;
}

/** The element renderConnected renders, for `rerender`. */
renderConnected.tree = function tree(ui: ReactNode, fake = fakeSession(), as: string | null = CB, opts: RenderOptions = {}) {
  const app: AppSession = {
    networks: [devnet],
    network: devnet,
    selectNetwork: () => {},
    overrides: {},
    saveOverrides: () => {},
    signer: as ? signer(as) : undefined,
    setSigner: () => {},
    session: fake.session,
    connecting: false,
    error: undefined,
    reconnect: () => {},
    notice: undefined,
    setNotice: () => {},
    ...opts.app,
  };
  const tree = (
    <AppSessionContext.Provider value={app}>
      <RtgsProvider session={fake.session}>
        <AutoKeeperProvider>{ui}</AutoKeeperProvider>
      </RtgsProvider>
    </AppSessionContext.Provider>
  );
  return opts.strict ? <StrictMode>{tree}</StrictMode> : tree;
}

/** The table row that names `name`. */
export function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByText(name)
    .map((e) => e.closest("tr"))
    .find((r): r is HTMLTableRowElement => !!r);
  if (!row) throw new Error(`no table row for ${name}`);
  return row;
}
