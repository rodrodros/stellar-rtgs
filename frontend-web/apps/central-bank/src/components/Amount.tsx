import { CASH_DECIMALS, formatAmount } from "@rtgs/core";

/** `12325000000n` -> `"1,233"`: whole units, rounded half away from zero, thousands grouped. */
export function amountText(stroops: bigint): string {
  const unit = 10n ** BigInt(CASH_DECIMALS);
  const abs = stroops < 0n ? -stroops : stroops;
  const whole = (abs + unit / 2n) / unit;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return stroops < 0n && whole > 0n ? `-${grouped}` : grouped;
}

/** An amount of the cash token, from bigint stroops. */
export function Amount(props: { value: bigint | undefined; code?: string }) {
  if (props.value === undefined) return <span className="muted">—</span>;
  return (
    <span className="amount" title={formatAmount(props.value)}>
      {amountText(props.value)}
      {props.code ? <span className="unit"> {props.code}</span> : null}
    </span>
  );
}
