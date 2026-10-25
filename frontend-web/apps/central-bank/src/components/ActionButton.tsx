import type { ButtonHTMLAttributes } from "react";

/**
 * A button that says why it is disabled: a stub entry point, the wrong signer, an action in
 * flight. The reason is shown, not only in a tooltip.
 */
export function ActionButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { disabledReason?: string | undefined }) {
  const { disabledReason, disabled, children, ...rest } = props;
  const off = disabled || !!disabledReason;
  return (
    <span className="action">
      <button type="button" {...rest} disabled={off} title={disabledReason}>
        {children}
      </button>
      {disabledReason ? <span className="hint">{disabledReason}</span> : null}
    </span>
  );
}
