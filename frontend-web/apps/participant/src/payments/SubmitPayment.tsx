// Submits a payment order to another participant from the bank registry.
import type { Priority } from "@rtgs/core";
import { useBankRegistry, useSession } from "@rtgs/core/react";
import { useState, type FormEvent } from "react";
import { useActingBank } from "../session/ActingBank.tsx";
import { useBankData } from "../session/BankData.tsx";
import { readAmount } from "../ui/format.ts";
import { TxStatus } from "../ui/TxStatus.tsx";
import { useTx } from "../ui/useTx.ts";
import { describeSubmit } from "./describe.ts";

export function SubmitPayment() {
  const session = useSession();
  const { actor } = useActingBank();
  const { address, refresh } = useBankData();
  const registry = useBankRegistry();
  const receivers = registry.filter((b) => b.address !== address);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const tx = useTx(refresh);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!actor) return;
    const parsed = readAmount(amount);
    if (!to) return tx.fail("Choose a receiver.");
    if (!parsed.ok) return tx.fail(parsed.message);
    void tx.run(
      "Submitting the payment order",
      () => actor.submit({ to, amount: parsed.value, priority }),
      async (outcome) => {
        let position: number | undefined;
        if (outcome.value.disposition === "queued") {
          const ids = await session.read.queue(address, priority).catch(() => [] as bigint[]);
          const i = ids.indexOf(outcome.value.id);
          if (i >= 0) position = i + 1;
        }
        setAmount("");
        return describeSubmit(outcome, priority, position);
      },
    );
  };

  return (
    <section className="panel" aria-labelledby="submit-title">
      <h2 id="submit-title">New payment order</h2>
      <form onSubmit={submit}>
        <label>
          Receiver
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a participant…</option>
            {receivers.map((b) => (
              <option key={b.address} value={b.address}>
                {session.registry.nameOf(b.address)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount ({session.cashToken.code})
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </label>
        <fieldset className="row">
          <legend>Priority class</legend>
          {(["normal", "urgent"] as const).map((p) => (
            <label key={p} className="inline">
              <input type="radio" name="priority" value={p} checked={priority === p} onChange={() => setPriority(p)} />
              {p === "urgent" ? "Urgent" : "Normal"}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="primary" disabled={!actor || !!tx.pending}>
          Submit
        </button>
      </form>
      {receivers.length === 0 && <p className="note">No other participant is known yet.</p>}
      <TxStatus state={tx} />
    </section>
  );
}
