import { RtgsProvider, useBankRegistry } from "@rtgs/core/react";
import { useEffect, useState } from "react";
import { NetworkBar } from "./components/NetworkBar.tsx";
import { Banks } from "./pages/Banks.tsx";
import { Credit } from "./pages/Credit.tsx";
import { Keeper } from "./pages/Keeper.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Setup } from "./pages/Setup.tsx";
import { useAppSession } from "./session/AppSession.tsx";

const TABS = { overview: "Overview", banks: "Banks", credit: "Credit", keeper: "Keeper", setup: "Setup" } as const;
type Tab = keyof typeof TABS;

function tabFromHash(): Tab {
  const hash = globalThis.location?.hash.replace(/^#\/?/, "") ?? "";
  return hash in TABS ? (hash as Tab) : "overview";
}

/** Hash navigation, so the static build needs no server routes. */
function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    globalThis.addEventListener?.("hashchange", onHash);
    return () => globalThis.removeEventListener?.("hashchange", onHash);
  }, []);
  return [tab, (t) => (globalThis.location ? (globalThis.location.hash = `/${t}`) : setTab(t))];
}

export function App() {
  const app = useAppSession();
  return (
    <div className="app">
      <NetworkBar />
      <main>
        {app.session ? (
          <RtgsProvider session={app.session} fallback={<p className="muted">Connecting…</p>}>
            <Connected />
          </RtgsProvider>
        ) : app.connecting ? (
          <p className="muted">Connecting to {app.network.label}…</p>
        ) : (
          <Setup />
        )}
      </main>
    </div>
  );
}

function Connected() {
  const [tab, setTab] = useTab();
  const app = useAppSession();
  const devnetBanks = useBankRegistry().filter((b) => b.sources.includes("devnet")).length;
  const readOnly = !app.signer || app.signer.address !== app.session?.centralBank;
  return (
    <>
      <nav className="tabs">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button key={t} type="button" className={t === tab ? "active" : undefined} aria-current={t === tab ? "page" : undefined} onClick={() => setTab(t)}>
            {TABS[t]}
          </button>
        ))}
      </nav>
      {readOnly ? (
        <p className="status warn" role="status">
          {app.signer
            ? "The connected signer is not this contract's central bank: the central bank's actions are disabled."
            : "No signer connected: the central bank's actions are disabled."}
        </p>
      ) : null}
      {tab === "overview" ? <Overview /> : null}
      {tab === "banks" ? <Banks /> : null}
      {tab === "credit" ? <Credit /> : null}
      {tab === "keeper" ? <Keeper /> : null}
      {tab === "setup" ? <Setup devnetBanks={devnetBanks} /> : null}
    </>
  );
}
