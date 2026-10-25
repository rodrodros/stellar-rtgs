// "An incoming payment settling should show without a refresh": a notice for each incoming
// settlement that the event feed delivers after the page loaded.
import { useSession, useStore } from "@rtgs/core/react";
import { useEffect, useRef, useState } from "react";
import { amountText } from "../ui/format.ts";

interface Notice {
  key: string;
  text: string;
}

export function Notices({ bank }: { bank: string }) {
  const session = useSession();
  const store = useStore();
  const [notices, setNotices] = useState<Notice[]>([]);
  const baseline = useRef<{ ledger: number; seen: string } | undefined>(undefined);

  useEffect(() => {
    const check = () => {
      const s = store.getSnapshot();
      // Events up to the ledger the store loaded at are history, not news.
      if (!baseline.current) {
        if (s.status !== "ready" || !s.ledger) return;
        baseline.current = { ledger: s.ledger.sequence, seen: s.events.at(-1)?.eventId ?? "" };
      }
      const base = baseline.current;
      const fresh = s.events.filter((e) => e.eventId > base.seen);
      if (!fresh.length) return;
      base.seen = fresh.at(-1)!.eventId;
      const incoming = fresh.flatMap((e) =>
        e.type === "Settled" && e.to === bank && e.ledger > base.ledger
          ? [
              {
                key: e.eventId,
                text: `Incoming payment order #${e.id} from ${session.registry.nameOf(e.from)} settled: ${amountText(e.amount, session.cashToken.code)}`,
              },
            ]
          : [],
      );
      if (incoming.length) setNotices((n) => [...incoming.reverse(), ...n].slice(0, 5));
    };
    check();
    return store.subscribe(check);
  }, [store, bank, session]);

  if (!notices.length) return null;
  return (
    <ul className="notices" aria-live="polite">
      {notices.map((n) => (
        <li key={n.key} role="status">
          {n.text}
          <button type="button" aria-label="Dismiss" onClick={() => setNotices((all) => all.filter((x) => x.key !== n.key))}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
