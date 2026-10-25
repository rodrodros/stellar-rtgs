// Which events concern one bank. Some events carry only an id (Revoked, Expired,
// Reprioritised, the repo events), so they are resolved through the store's payment orders
// and repos.
import type { FeedEvent, SystemSnapshot } from "@rtgs/core";

type Lookups = Pick<SystemSnapshot, "payments" | "repos">;

export function touches(event: FeedEvent, bank: string, { payments, repos }: Lookups): boolean {
  const involves = (id: bigint) => {
    const p = payments.get(id);
    return !!p && (p.from === bank || p.to === bank);
  };
  switch (event.type) {
    case "Deposited":
    case "Withdrawn":
    case "CollateralSet":
    case "RepoOpened":
      return event.bank === bank;
    case "Submitted":
    case "Settled":
      return event.from === bank || event.to === bank;
    case "Revoked":
    case "Expired":
    case "Reprioritised":
      return involves(event.id);
    case "Offset":
      return event.ids.some(involves);
    case "RepoRepaid":
    case "RepoPenalised":
      return repos.get(event.id)?.bank === bank;
    case "Token":
      return event.from === bank || event.to === bank;
    case "Unknown":
      return false;
  }
}

/**
 * The id of the newest event that concerns `bank`, or "" if none: a key that changes exactly
 * when the bank's views need reading again.
 */
export function lastTouching(snapshot: Pick<SystemSnapshot, "events" | "payments" | "repos">, bank: string): string {
  const { events } = snapshot;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (touches(event, bank, snapshot)) return event.eventId;
  }
  return "";
}
