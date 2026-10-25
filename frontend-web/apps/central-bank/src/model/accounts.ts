/**
 * Core's registry already leaves out the central bank and the settlement contract; the app
 * checks again, since a bank row offers clawback and an unconfirmed deauthorization (H1).
 */
export function isBank(address: string, session: { contractId: string; centralBank: string }): boolean {
  return address !== session.contractId && address !== session.centralBank;
}
