// The connection controls (network, contract, mainnet confirmation) and the live status lines:
// the ledger clock, the feed, and the RPC retention window that bounds the loaded events.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { STORE_EVENT_LIMIT, useLedgerClock, useSession, useSnapshot, type NetworkConfig } from "../core.ts";
import { formatDuration } from "../model/expiry.ts";
import { checkStartLedger, ledgerSecondsAgo, retentionWindow, type StartChoice } from "../model/retention.ts";
import { isContractId } from "../model/url.ts";
import { useNav, useQuery } from "../state/query.tsx";
import { Time } from "./format.tsx";

export function ConnectBar(props: { networks: NetworkConfig[]; selected: string | undefined; contractId: string | undefined }) {
  const { update } = useQuery();
  const [contract, setContract] = useState(props.contractId ?? "");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setContract(props.contractId ?? ""), [props.contractId]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = contract.trim();
    if (value && !isContractId(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    update({ contract: value || undefined, invalidContract: undefined, payment: undefined, tx: undefined, ledger: undefined });
  };

  return (
    <form className="connect" onSubmit={submit}>
      <label>
        Network
        <select
          value={props.selected ?? ""}
          onChange={(e) =>
            update({ network: e.target.value, contract: undefined, invalidContract: undefined, payment: undefined, tx: undefined, ledger: undefined })
          }
        >
          {props.selected === undefined && <option value="">Choose…</option>}
          {props.networks.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </label>
      <label className="contract-field">
        Settlement contract
        <input
          value={contract}
          onChange={(e) => setContract(e.target.value)}
          placeholder="from config, or found on the central bank's account"
          spellCheck={false}
          aria-invalid={invalid}
        />
      </label>
      <button type="submit">Watch</button>
      {invalid && <span className="error">A contract id starts with C and has 56 characters.</span>}
    </form>
  );
}

export function MainnetConfirm(props: { onConfirm(): void; onCancel(): void }) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-labelledby="mainnet-title" aria-describedby="mainnet-body">
        <h2 id="mainnet-title">Watch mainnet?</h2>
        <p id="mainnet-body">
          Mainnet is the public Stellar network, with real funds. The observer only reads: it holds no keys and signs nothing. Confirm that you
          mean to read from mainnet.
        </p>
        <div className="modal-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" ref={confirm} onClick={props.onConfirm}>
            Watch mainnet
          </button>
        </div>
      </div>
    </div>
  );
}

const FEED_STATE: Record<string, string> = { idle: "idle", backfilling: "loading history", live: "live", error: "feed error" };

export function ChainStatus() {
  const session = useSession();
  const feed = useSnapshot((s) => s.feed);
  const { sequence, closeTime } = useLedgerClock();
  return (
    <div className="chain-status">
      <span className={`network-badge network-${session.network.id}`}>{session.network.label}</span>
      <span className="mono" title={session.contractId}>
        {session.contractId.slice(0, 6)}…{session.contractId.slice(-4)}
      </span>
      <span>
        ledger <strong>{sequence?.toLocaleString() ?? "…"}</strong>
        {closeTime !== undefined && (
          <>
            {" "}
            closed <Time at={closeTime} />
          </>
        )}
      </span>
      <span className={`feed feed-${feed.state}`} title={feed.error ? `${feed.error.title}: ${feed.error.detail}` : undefined}>
        <span className="dot" aria-hidden /> {FEED_STATE[feed.state] ?? feed.state}
      </span>
    </div>
  );
}

type Preset = "retention" | "hour" | "now" | "ledger";

const presetOf = (from: StartChoice): Preset => (from === "retention" ? "retention" : from === "now" ? "now" : "ledger");

export function RetentionBar() {
  const { query, update } = useQuery();
  const feed = useSnapshot((s) => s.feed);
  const kept = useSnapshot((s) => s.events.length);
  const retention = retentionWindow(feed);
  const [preset, setPreset] = useState<Preset>(presetOf(query.from));
  const [ledger, setLedger] = useState(typeof query.from === "number" ? String(query.from) : "");
  const [problem, setProblem] = useState<string>();

  const load = (e: FormEvent) => {
    e.preventDefault();
    if (preset === "retention" || preset === "now") {
      setProblem(undefined);
      update({ from: preset });
      return;
    }
    if (preset === "hour") {
      if (!retention) return setProblem("The retention window isn't known yet.");
      setProblem(undefined);
      const from = ledgerSecondsAgo(retention, 3_600);
      setLedger(String(from));
      setPreset("ledger");
      update({ from });
      return;
    }
    const n = Number(ledger);
    const why = checkStartLedger(n, retention);
    setProblem(why);
    if (!why) update({ from: n });
  };

  return (
    <div className="retention">
      <p>
        {retention ? (
          <>
            RPC keeps ledgers {retention.oldestLedger.toLocaleString()}–{retention.latestLedger.toLocaleString()} (about{" "}
            {formatDuration(retention.spanSecs)}, since <Time at={retention.oldestCloseTime} withDate />
            ). Earlier events are gone; balances and queues are still read live from the contract. Older events would need an indexer.
          </>
        ) : (
          <>Reading the RPC retention window…</>
        )}
      </p>
      <p>
        {feed.startLedger !== undefined ? <>Events loaded from ledger {feed.startLedger.toLocaleString()}. </> : null}
        {feed.state === "backfilling" && feed.cursorLedger !== undefined && feed.latestLedger !== undefined && (
          <>
            Loading: read up to ledger {feed.cursorLedger.toLocaleString()} of {feed.latestLedger.toLocaleString()}.{" "}
          </>
        )}
        {feed.clamped && <span className="warn">The requested start was older than the retention window, so loading starts at its oldest ledger. </span>}
        {kept >= STORE_EVENT_LIMIT && (
          <span className="warn">Only the newest {STORE_EVENT_LIMIT.toLocaleString()} events are kept; older ones have left the timeline. </span>
        )}
      </p>
      <form className="start" onSubmit={load}>
        <label>
          Load events from
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            <option value="retention">the whole retention window</option>
            <option value="hour">the last hour</option>
            <option value="now">now (live only)</option>
            <option value="ledger">ledger…</option>
          </select>
        </label>
        {preset === "ledger" && (
          <input
            aria-label="Start ledger"
            inputMode="numeric"
            value={ledger}
            onChange={(e) => setLedger(e.target.value.replace(/\D/g, ""))}
            placeholder={retention ? `${retention.oldestLedger}–${retention.latestLedger}` : "ledger"}
          />
        )}
        <button type="submit">Load</button>
        {problem && <span className="error">{problem}</span>}
      </form>
    </div>
  );
}

export function PaymentSearch() {
  const nav = useNav();
  const [text, setText] = useState("");
  return (
    <form
      className="search"
      onSubmit={(e) => {
        e.preventDefault();
        const id = text.trim().replace(/^#/, "");
        if (/^\d+$/.test(id)) nav.openPayment(BigInt(id));
      }}
    >
      <input aria-label="Payment order id" placeholder="Follow payment order #…" value={text} onChange={(e) => setText(e.target.value)} />
    </form>
  );
}
