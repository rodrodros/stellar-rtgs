// Deterministic runs that pin the oracle to known outcomes, before its traces judge the
// contract. Each one names the scenario of tests/SCENARIOS.md that it mirrors.
// Run: quint test settlement_test.qnt
module settlement_test {
  import settlement.* from "./settlement"

  // Every bank deposits `x`.
  action fundAll(x: int): bool = deposit("A", x).then(deposit("B", x)).then(deposit("C", x))

  // SC-A01-01. A1, A2: a covered payment settles at once (ADR-0008).
  run coveredPaymentSettlesAtOnceTest =
    init.then(deposit("A", 100)).then(submit("A", "B", 40, "Normal"))
      .expect(settledNow == [0] and balances.get("A") == 60 and balances.get("B") == 40 and lastValue == 0)

  // SC-A01-15. CPSS Box 4 under strict FIFO: only the 40 settles (S7, §4.11).
  run cpssBox4StrictFifoTest =
    init.then(deposit("A", 100))
      .then(submit("A", "B", 40, "Normal"))
      .then(submit("A", "B", 70, "Normal"))
      .then(submit("A", "B", 20, "Normal"))
      .then(submit("A", "B", 30, "Normal"))
      .then(submit("A", "B", 10, "Normal"))
      .expect(queueOf(payments, nextId, "A", "Normal") == [1, 2, 3, 4] and balances.get("A") == 60)

  // SC-A01-13. S7(a): an urgent payment settles ahead of a queued normal one (ADR-0009).
  run urgentSettlesAheadOfNormalTest =
    init.then(deposit("A", 50))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 10, "Urgent"))
      .expect(settledNow == [1] and queueOf(payments, nextId, "A", "Normal") == [0])

  // SC-A01-09. The cap refuses only a payment that would stay queued (ADR-0010).
  run queueCapTest =
    init.then(deposit("A", 5))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 60, "Normal"))
      .expect(lastError == "QueueFull" and nextId == 6)
      .then(submit("A", "B", 5, "Urgent"))
      .expect(lastError == "" and settledNow == [6])

  // SC-A01-23. At the cap, a payment that completes an offset is accepted: the cap
  // refuses only a payment still queued after the closure (A3, S23, ADR-0010; decided
  // with the user on 2026-10-25).
  run queueCapOffsetTest =
    init.then(submit("A", "B", 10, "Normal"))
      .then(submit("A", "B", 10, "Normal"))
      .then(submit("A", "B", 10, "Normal"))
      .then(submit("A", "B", 10, "Normal"))
      .then(submit("A", "B", 10, "Normal"))
      .then(submit("A", "B", 10, "Normal"))
      .expect(queuedCount(payments, nextId) == QUEUE_CAP)
      .then(submit("B", "A", 60, "Normal"))
      .expect(lastError == "" and lastValue == 6 and offsetsNow == [[0, 1, 2, 3, 4, 5, 6]] and
              queuedCount(payments, nextId) == 0)

  // SC-A03-01. R7's gridlock: gross settles nothing (k_seq = 0), and the third
  // submission applies k* = (1, 1, 1) as one offset (A3, S23, R7, ADR-0010).
  run r7GridlockTest =
    init.then(fundAll(10))
      .then(submit("A", "B", 15, "Normal"))
      .then(submit("B", "C", 20, "Normal"))
      .expect(settledNow == [])
      .then(submit("C", "A", 25, "Normal"))
      .expect(offsetsNow == [[0, 1, 2]] and settledNow == [0, 1, 2] and
              balances.get("A") == 20 and balances.get("B") == 5 and balances.get("C") == 5)

  // SC-A03-03. The greatest feasible prefix, not all or nothing (R4, Spec O).
  run greatestPrefixTest =
    init.then(submit("A", "B", 50, "Normal"))
      .then(submit("A", "B", 30, "Normal"))
      .then(submit("B", "A", 50, "Normal"))
      .expect(offsetsNow == [[0, 2]] and queueOf(payments, nextId, "A", "Normal") == [1])

  // SC-A03-04. F2, F6: the offset never overtakes an older payment (ADR-0008).
  run noOvertakingTest =
    init.then(submit("A", "B", 100, "Normal"))
      .then(submit("A", "B", 50, "Normal"))
      .then(submit("B", "A", 50, "Normal"))
      .expect(settledNow == [] and queuedCount(payments, nextId) == 3)

  // SC-A03-05. ≺ puts a bank's urgent payments first in its prefix (ADR-0009).
  run urgentFirstInPrefixTest =
    init.then(submit("A", "B", 50, "Normal"))
      .then(submit("A", "B", 100, "Urgent"))
      .then(submit("B", "A", 50, "Normal"))
      .expect(settledNow == [])

  // SC-A03-06. A deposit can make an offset feasible (ADR-0010).
  run depositMakesOffsetFeasibleTest =
    init.then(submit("A", "B", 60, "Normal"))
      .then(submit("B", "A", 50, "Normal"))
      .expect(settledNow == [])
      .then(deposit("A", 10))
      .expect(offsetsNow == [[0, 1]])

  // SC-A02-05. The new payment settles first, then the receiver's queue (S9).
  run cascadeTest =
    init.then(submit("B", "C", 30, "Normal"))
      .then(deposit("A", 30))
      .then(submit("A", "B", 30, "Normal"))
      .expect(settledNow == [1, 0] and offsetsNow == [])

  // SC-A05-02, SC-A05-04. A5: `NotExpired` at exactly the expiry, then expiring the head
  // releases the payment behind it (S9, ADR-0015).
  run expiringTheHeadReleasesTest =
    init.then(deposit("A", 50))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 10, "Normal"))
      .then(tick(EXPIRY))
      .then(expire(0))
      .expect(lastError == "NotExpired")
      .then(tick(1))
      .then(expire(0))
      .expect(lastError == "" and settledNow == [1] and payments.get(0).status == "Expired")

  // SC-A06-07. A6: revoking the head releases the payment behind it (S9, ADR-0016).
  run revokingTheHeadReleasesTest =
    init.then(deposit("A", 50))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 10, "Normal"))
      .then(revoke(0))
      .expect(settledNow == [1] and payments.get(0).status == "Revoked")
      .then(revoke(0))
      .expect(lastError == "NotQueued")
      .then(revoke(7))
      .expect(lastError == "UnknownPayment")

  // SC-A06-02. No cut-off: past its expiry, a payment not yet expired can be revoked.
  run revocationHasNoCutOffTest =
    init.then(submit("A", "B", 60, "Normal"))
      .then(tick(EXPIRY + 100))
      .then(revoke(0))
      .expect(lastError == "" and payments.get(0).status == "Revoked")

  // SC-A08-03, SC-A08-05. A8: promoting a covered payment stuck behind an uncovered head
  // settles it; a move to the same priority is `SamePriority` (ADR-0009).
  run promotionSettlesTest =
    init.then(deposit("A", 50))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 10, "Normal"))
      .then(reprioritise(1, "Normal"))
      .expect(lastError == "SamePriority")
      .then(reprioritise(1, "Urgent"))
      .expect(settledNow == [1] and payments.get(1).priority == "Urgent")

  // SC-A08-01. A promoted payment keeps its place by age (A8 with toEnd = false).
  run promotionKeepsAgeTest =
    init.then(submit("A", "B", 60, "Urgent"))
      .then(submit("A", "B", 60, "Normal"))
      .then(submit("A", "B", 60, "Urgent"))
      .then(reprioritise(1, "Urgent"))
      .expect(queueOf(payments, nextId, "A", "Urgent") == [0, 1, 2])

  // SC-A02-07. S3, S5: a settled payment's record never changes, its settlement time
  // included, through later time, payments and a withdrawal (ADR-0005, ADR-0006).
  run settledPaymentNeverChangesTest =
    init.then(deposit("A", 100))
      .then(tick(5))
      .then(submit("A", "B", 40, "Normal"))
      .then(tick(EXPIRY + 1))
      .then(submit("A", "B", 70, "Normal"))
      .expect(S5_irrevocability)
      .then(withdraw("A", 60))
      .expect(S3_finalStaysFinal and S5_irrevocability and
              payments.get(0).status == "Settled" and payments.get(0).settledAt == 5)

  // SC-F-04, SC-F-08. Funding errors.
  run fundingErrorsTest =
    init.then(deposit("A", FUNDING + 1))
      .expect(lastError == "TokenTransferFailed")
      .then(withdraw("A", 1))
      .expect(lastError == "InsufficientFunds")
}
