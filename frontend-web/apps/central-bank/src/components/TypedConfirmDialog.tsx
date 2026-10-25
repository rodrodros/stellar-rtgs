import { useState, type ReactNode } from "react";

/**
 * A confirmation for an action that is hard to undo: the user types `word` to enable it.
 * Used for selecting mainnet and for freezing the settlement contract.
 */
export function TypedConfirmDialog(props: {
  title: string;
  word: string;
  confirmLabel: string;
  children: ReactNode;
  onConfirm(): void;
  onCancel(): void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.title}>
        <h3>{props.title}</h3>
        <div className="dialog-body">{props.children}</div>
        <label>
          Type <code>{props.word}</code> to confirm
          <input aria-label={`Type ${props.word} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </label>
        <div className="row">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" disabled={typed !== props.word} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
