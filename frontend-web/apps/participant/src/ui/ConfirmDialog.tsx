import { useState, type ReactNode } from "react";

/** A modal that asks the user to type `phrase` before it confirms. */
export function ConfirmDialog(props: {
  title: string;
  phrase: string;
  confirmLabel: string;
  children: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{props.title}</h2>
        {props.children}
        <label>
          Type <code>{props.phrase}</code> to confirm
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="row">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" disabled={typed.trim() !== props.phrase} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
