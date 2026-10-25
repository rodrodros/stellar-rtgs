// Setup: on devnet, the one-click bootstrap (core's bootstrapDevnet, which mirrors
// integration/lib.sh); on any network, pointing the app at a deployment and an RPC.
import {
  DEFAULT_CASH,
  DEFAULT_CONFIG,
  bootstrapDevnet,
  formatAmount,
  loadSettlementWasm,
  parseAmount,
  toRtgsError,
  type BootstrapStep,
  type Config,
  type NetworkOverrides,
  type RtgsError,
} from "@rtgs/core";
import { useState } from "react";
import { parseConfig, parseWhole, type ConfigForm } from "../model/setupForm.ts";
import { useAppSession } from "../session/AppSession.tsx";

export function Setup(props: { devnetBanks?: number }) {
  const app = useAppSession();
  return (
    <section>
      <h2>Setup</h2>
      {app.error ? (
        <p className="status error" role="alert">
          <strong>{app.error.title}</strong> {app.error.detail}
        </p>
      ) : null}
      {app.network.id === "devnet" ? <DevnetBootstrap {...props} /> : null}
      <DeploymentForm />
    </section>
  );
}

const STEP_LABELS: Record<BootstrapStep["step"], string> = {
  fund: "Fund the central bank and the banks (friendbot)",
  "issuer-flags": "Set AUTH_REQUIRED, AUTH_REVOCABLE and CLAWBACK_ENABLED on the issuer (ADR-0003)",
  sac: "Deploy the cash token's SAC",
  banks: "Open, authorize and fund each bank's trustline",
  contract: "Upload the Wasm and deploy the settlement contract",
  "authorize-contract": "Authorize the settlement contract to hold the cash token",
  publish: "Publish the contract and the bank registry on the central bank's account",
};

function DevnetBootstrap(props: { devnetBanks?: number }) {
  const app = useAppSession();
  const [form, setForm] = useState<ConfigForm>(
    () => Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([k, v]) => [k, String(v)])) as ConfigForm,
  );
  const [banksText, setBanksText] = useState(String(Math.max(3, props.devnetBanks ?? 0)));
  const [cash, setCash] = useState(formatAmount(DEFAULT_CASH));
  const [fresh, setFresh] = useState(false);
  const [steps, setSteps] = useState<BootstrapStep[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<RtgsError>();
  const [done, setDone] = useState<string>();

  const parsedConfig = parseConfig(form);
  const banks = parseWhole(banksText, 1, 20);
  let cashValue: bigint | undefined;
  try {
    cashValue = parseAmount(cash);
  } catch {
    cashValue = undefined;
  }
  const problems = [
    "invalid" in parsedConfig && `whole numbers needed for ${parsedConfig.invalid.join(", ")}`,
    banks === undefined && "banks must be a whole number from 1 to 20",
    (cashValue === undefined || cashValue < 0n) && "cash per bank must be an amount",
  ].filter((p): p is string => !!p);

  const run = async () => {
    if (problems.length || !("config" in parsedConfig) || banks === undefined || cashValue === undefined) return;
    const config = parsedConfig.config;
    setRunning(true);
    setError(undefined);
    setDone(undefined);
    setSteps([]);
    try {
      const deployment = await bootstrapDevnet({
        network: app.network,
        wasm: await loadSettlementWasm(),
        config,
        banks,
        cash: cashValue,
        fresh,
        onStep: (s) => setSteps((all) => [...all.filter((x) => x.step !== s.step), s]),
      });
      setDone(deployment.contractId);
      // Reconnecting unmounts this page, so the result goes to the app-level notice.
      app.setNotice(
        `Devnet bootstrapped: settlement contract ${deployment.contractId}, cash token ${deployment.cashToken.code} ` +
          `(${deployment.sacId}), ${deployment.banks.length} banks onboarded.`,
      );
      app.reconnect();
    } catch (e) {
      setError(toRtgsError(e));
    } finally {
      setRunning(false);
    }
  };

  const num = (key: keyof Config) => (
    <label>
      {key}
      <input aria-label={key} inputMode="numeric" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} disabled={running} />
    </label>
  );

  return (
    <div className="card">
      <h3>Bootstrap the devnet</h3>
      <p className="muted">
        Creates the central bank and the banks from the devnet seed, issues the cash token with the ADR-0003 flags, deploys
        its SAC and the settlement contract, and onboards the banks. Each step checks what is already there, so running it
        again with more banks onboards only the new ones. The Config applies only to a newly deployed contract.
      </p>
      <fieldset className="grid" disabled={running}>
        <legend>Config</legend>
        {num("queueCap")}
        {num("expirySecs")}
        {num("repoTermSecs")}
        {num("penaltyRateBps")}
      </fieldset>
      <div className="row">
        <label>
          Banks
          <input aria-label="Banks" inputMode="numeric" value={banksText} onChange={(e) => setBanksText(e.target.value)} disabled={running} />
        </label>
        <label>
          Cash per bank
          <input aria-label="Cash per bank" value={cash} onChange={(e) => setCash(e.target.value)} disabled={running} />
        </label>
        <label className="inline">
          <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} disabled={running} />
          Deploy a new contract even if one is live
        </label>
        <button type="button" onClick={run} disabled={running || problems.length > 0}>
          {running ? "Bootstrapping…" : "Bootstrap"}
        </button>
      </div>
      {problems.length ? <p className="hint error">Fix the form: {problems.join("; ")}.</p> : null}
      {steps.length ? (
        <ol className="steps">
          {steps.map((s) => (
            <li key={s.step} className={s.status}>
              {STEP_LABELS[s.step]}: {s.status === "start" ? "…" : s.status}
              {s.detail ? <span className="mono muted"> {s.detail}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {error ? (
        <p className="status error" role="alert">
          <strong>{error.title}</strong> {error.detail}
        </p>
      ) : null}
      {done ? <p className="status ok">Deployed and published: <span className="mono">{done}</span></p> : null}
    </div>
  );
}

function DeploymentForm() {
  const app = useAppSession();
  const [contractId, setContractId] = useState(app.overrides.contractId ?? "");
  const [rpcUrl, setRpcUrl] = useState(app.overrides.rpcUrl ?? "");
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        // An empty field means the build's setting, so it is left out (core treats "" as "unset").
        const next: NetworkOverrides = {};
        if (contractId.trim()) next.contractId = contractId.trim();
        if (rpcUrl.trim()) next.rpcUrl = rpcUrl.trim();
        app.saveOverrides(next);
      }}
    >
      <h3>Deployment on {app.network.label}</h3>
      <p className="muted">
        {app.network.id === "devnet"
          ? "Leave the contract empty to use the one the central bank published. "
          : "Point the app at an existing settlement contract. "}
        The cash token is read from the contract. Leave a field empty to use the build's setting.
      </p>
      <label>
        Settlement contract id
        <input value={contractId} onChange={(e) => setContractId(e.target.value)} placeholder={app.network.contractId ?? "C…"} />
      </label>
      <label>
        RPC URL
        <input value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} placeholder={app.network.rpcUrl || "https://…"} />
      </label>
      <button type="submit">Save and connect</button>
      {app.session ? (
        <p className="muted">
          Connected: central bank <span className="mono">{app.session.centralBank}</span>, cash token{" "}
          {app.session.cashToken.code} (<span className="mono">{app.session.cashToken.sacId}</span>)
        </p>
      ) : app.connecting ? (
        <p className="muted">Connecting…</p>
      ) : null}
    </form>
  );
}
