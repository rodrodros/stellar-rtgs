import type { TxState } from "./useTx.ts";

/** The outcome line under a form: pending, the error in core's words, or what happened. */
export function TxStatus({ state }: { state: TxState }) {
  if (state.pending) return <p className="tx tx-pending" role="status">{state.pending}…</p>;
  if (state.error) {
    return (
      <p className="tx tx-error" role="alert">
        <strong>{state.error.title}</strong>
        {state.error.detail ? ` ${state.error.detail}` : ""}
      </p>
    );
  }
  if (state.done) return <p className="tx tx-done" role="status">{state.done}</p>;
  return null;
}
