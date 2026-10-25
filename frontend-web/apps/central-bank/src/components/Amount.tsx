import { formatAmount } from "@rtgs/core";

/** An amount of the cash token, from bigint stroops. */
export function Amount(props: { value: bigint | undefined; code?: string }) {
  if (props.value === undefined) return <span className="muted">—</span>;
  return (
    <span className="amount">
      {formatAmount(props.value)}
      {props.code ? <span className="unit"> {props.code}</span> : null}
    </span>
  );
}
