// Amounts are bigint stroops everywhere in core: the units of the cash token's SAC and of the
// settlement contract. A classic asset has 7 decimals.
export const CASH_DECIMALS = 7;

/** `12345000000n` -> `"1234.5"`. Exact, with no trailing zeros after the point. */
export function formatAmount(stroops: bigint, decimals = CASH_DECIMALS): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** `"1234.5"` -> `12345000000n`. Throws on anything but a plain decimal with at most `decimals` places. */
export function parseAmount(text: string, decimals = CASH_DECIMALS): bigint {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim().replaceAll(",", ""));
  if (!match) throw new Error(`not an amount: "${text}"`);
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places`);
  const stroops = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return sign ? -stroops : stroops;
}
