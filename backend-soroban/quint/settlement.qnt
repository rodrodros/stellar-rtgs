// Contract-level model of the settlement contract (contracts/settlement/src/lib.rs):
// funding, payments, the two FIFO queues and the eager LSM. Credit and repos are not
// modelled yet.
//
// It is the oracle for model-based testing (TESTING.md §3). `quint run --mbt --out-itf`
// writes traces, and contracts/settlement/src/tests/itf_replay.rs replays each step
// against the contract, comparing the outcome and the resulting state.
//
// The rules are κ-proto's (rtgs-definition.md §4.11) as the ADRs amend them. This model
// departs from ../stellar-research/definition/model/rtgs.qnt in these ways:
// - No A17 `Open`, A18 `Close`, business day or value dates. The system runs 24/7, so
//   every queued payment is eligible (ADR-0013).
// - No τ_rej or τ_qc. A queued payment instead expires `EXPIRY` seconds after it was
//   submitted, and A5 is the explicit `expire`. Anyone may call it, and the guard is
//   `now > submittedAt + EXPIRY` (ADR-0015). Until someone expires it, a payment past its
//   expiry stays queued and can still settle or be revoked (SC-A06-02).
// - No revocation cut-off τ_rc. A6 is allowed until settlement (ADR-0016), so S20 holds
//   trivially.
// - No timed orders (ADR-0017), and no reservations or limits (ADR-0018). Each bank has
//   one account, so there is no A11 and cover is `bal - a >= 0` (ADR-0011).
// - A queue cap across all banks (ADR-0010's consequences). A submission is refused with
//   `QueueFull` only if the payment would still be queued after the eager closure, and
//   the queue would then hold more than `QUEUE_CAP` payments (SC-A01-09).
// - A8 keeps the sequence number, so toEnd = false (SC-A08-01).
//
// Amounts are always positive here. The `InvalidAmount` checks and the `i128` boundaries
// are covered by the unit tests, so the model spends its steps on queueing behaviour.
module settlement {
  pure val BANKS = List("A", "B", "C")
  pure val FUNDING = 500
  pure val QUEUE_CAP = 6
  pure val EXPIRY = 10
  pure val AMOUNTS = 1.to(300)
  pure val PRIORITIES = Set("Normal", "Urgent")

  // A payment as the contract stores it (lib.rs `Payment`). `settledAt` is -1 until it
  // settles. Its status is "Queued", "Settled", "Revoked" or "Expired".
  type Payment = {
    id: int, payer: str, payee: str, amount: int, priority: str,
    submittedAt: int, status: str, settledAt: int,
  }

  // The cash tokens each bank holds outside the contract.
  var reserve: str -> int
  // The settlement balances inside the contract.
  var balances: str -> int
  var payments: int -> Payment
  var nextId: int
  // A19: the ledger's close time.
  var now: int
  // The result of the last call. lastError is "" on success, and otherwise the contract's
  // error name. lastValue is the success value: the payment id for submit, and 0 otherwise.
  var lastError: str
  var lastValue: int
  // The ids the last call settled, in the order of their `Settled` events.
  var settledNow: List[int]
  // The ids of each `Offset` event the last call published, in order.
  var offsetsNow: List[List[int]]
  // History: each payment's status before the last call, for S3 and S5.
  var prevStatus: int -> str

  // ---- Queues and cover (§4.5) ----

  // The ids of the queued payments that match `f`, in ascending order.
  pure def queuedIds(ps: int -> Payment, n: int, f: Payment => bool): List[int] =
    range(0, n).foldl(List(), (l, i) =>
      if (ps.keys().contains(i) and ps.get(i).status == "Queued" and f(ps.get(i)))
        l.append(i)
      else l)

  // A bank's queue at one priority, head first (lib.rs `queue`).
  pure def queueOf(ps: int -> Payment, n: int, bank: str, priority: str): List[int] =
    queuedIds(ps, n, p => p.payer == bank and p.priority == priority)

  // ≺ on one bank's queued payments: urgent before normal, then by sequence number
  // (ADR-0008, ADR-0009).
  pure def candidates(ps: int -> Payment, n: int, bank: str): List[int] =
    queueOf(ps, n, bank, "Urgent").concat(queueOf(ps, n, bank, "Normal"))

  pure def queuedCount(ps: int -> Payment, n: int): int =
    queuedIds(ps, n, _ => true).length()

  // Rel_a under strict FIFO: the head of the bank's top class, if it is covered.
  // Returns the id, or -1.
  pure def release(bals: str -> int, ps: int -> Payment, n: int, bank: str): int = {
    val c = candidates(ps, n, bank)
    if (c.length() > 0 and bals.get(bank) >= ps.get(c[0]).amount) c[0] else -1
  }

  // ---- Settlement (A2, A3) ----

  pure def settleOne(bals: str -> int, ps: int -> Payment, id: int, t: int)
    : (str -> int, int -> Payment) = {
    val p = ps.get(id)
    (bals.set(p.payer, bals.get(p.payer) - p.amount).set(p.payee, bals.get(p.payee) + p.amount),
     ps.set(id, { ...p, status: "Settled", settledAt: t }))
  }

  // S(k): the first k(a) candidates of each bank.
  pure def prefixSet(ps: int -> Payment, n: int, k: str -> int): Set[int] =
    BANKS.foldl(Set(), (s, b) => {
      val c = candidates(ps, n, b)
      s.union(range(0, k.get(b)).foldl(Set(), (t, i) => t.union(Set(c[i]))))
    })

  // F1 for one bank: its balance after S stays at or above 0.
  pure def afterSet(bals: str -> int, ps: int -> Payment, S: Set[int], b: str): int =
    S.fold(bals.get(b), (x, id) => {
      val p = ps.get(id)
      x - (if (p.payer == b) p.amount else 0) + (if (p.payee == b) p.amount else 0)
    })

  // k* by descent (R4, §4.11): start from every candidate and, while some bank breaks F1,
  // drop the last candidate of the lowest such bank. Each round drops at most one
  // candidate, so `n` rounds are enough.
  pure def kstar(bals: str -> int, ps: int -> Payment, n: int): str -> int = {
    val top = BANKS.foldl(Map(), (m, b) => m.put(b, candidates(ps, n, b).length()))
    range(0, n + 1).foldl(top, (k, _) => {
      val S = prefixSet(ps, n, k)
      val bad = BANKS.select(b => afterSet(bals, ps, S, b) < 0)
      if (bad.length() == 0) k else k.set(bad[0], k.get(bad[0]) - 1)
    })
  }

  pure def isZero(k: str -> int): bool = BANKS.foldl(true, (z, b) => z and k.get(b) == 0)

  // The ids of S, ascending: the order of an `Offset` event and of its `Settled` events.
  pure def sorted(S: Set[int], n: int): List[int] =
    range(0, n).foldl(List(), (l, i) => if (S.contains(i)) l.append(i) else l)

  // The eager closure (§4.6, ADR-0010) under Restart: settle the covered head of the
  // lowest bank that has one, until none is left. At rest, if k* ≠ 0, apply S(k*) as one
  // offset and go back to gross settlement. Each round settles at least one payment while
  // any can settle, so `n + 1` rounds reach rest.
  pure def closure(bals: str -> int, ps: int -> Payment, n: int, t: int)
    : (str -> int, int -> Payment, List[int], List[List[int]]) =
    range(0, n + 1).foldl((bals, ps, List(), List()), (acc, _) => {
      val b0 = acc._1
      val p0 = acc._2
      val heads = BANKS.select(b => release(b0, p0, n, b) >= 0)
      if (heads.length() > 0) {
        val id = release(b0, p0, n, heads[0])
        val r = settleOne(b0, p0, id, t)
        (r._1, r._2, acc._3.append(id), acc._4)
      } else {
        val k = kstar(b0, p0, n)
        if (isZero(k)) acc
        else {
          val ids = sorted(prefixSet(p0, n, k), n)
          val r = ids.foldl((b0, p0), (bp, id) => settleOne(bp._1, bp._2, id, t))
          (r._1, r._2, acc._3.concat(ids), acc._4.append(ids))
        }
      }
    })

  pure def statuses(ps: int -> Payment): int -> str = ps.keys().mapBy(i => ps.get(i).status)

  // ---- Actions ----

  action rejected(error: str): bool = all {
    lastError' = error,
    lastValue' = 0,
    reserve' = reserve,
    balances' = balances,
    payments' = payments,
    nextId' = nextId,
    now' = now,
    settledNow' = List(),
    offsetsNow' = List(),
    prevStatus' = statuses(payments),
  }

  // A successful call: apply its own effect, then the eager closure.
  action commit(bals: str -> int, ps: int -> Payment, n: int, value: int): bool = {
    val r = closure(bals, ps, n, now)
    all {
      balances' = r._1,
      payments' = r._2,
      nextId' = n,
      now' = now,
      settledNow' = r._3,
      offsetsNow' = r._4,
      lastError' = "",
      lastValue' = value,
      prevStatus' = statuses(payments),
    }
  }

  // Funding, not a model action (SC-F). The closure runs, because new liquidity can
  // release a head (SC-A02-01) or make an offset feasible (SC-A03-06).
  action deposit(bank: str, amount: int): bool =
    if (reserve.get(bank) < amount) rejected("TokenTransferFailed")
    else all {
      reserve' = reserve.set(bank, reserve.get(bank) - amount),
      commit(balances.set(bank, balances.get(bank) + amount), payments, nextId, 0),
    }

  // Funding. A withdrawal never releases anything (SC-A02-06), but the closure runs
  // anyway, as it does after every successful call.
  action withdraw(bank: str, amount: int): bool =
    if (balances.get(bank) < amount) rejected("InsufficientFunds")
    else all {
      reserve' = reserve.set(bank, reserve.get(bank) + amount),
      commit(balances.set(bank, balances.get(bank) - amount), payments, nextId, 0),
    }

  // A1, then A2 and A3 in the same call.
  action submit(payer: str, payee: str, amount: int, priority: str): bool =
    if (payer == payee) rejected("SameAccount")
    else {
      val p = {
        id: nextId, payer: payer, payee: payee, amount: amount, priority: priority,
        submittedAt: now, status: "Queued", settledAt: -1,
      }
      val ps = payments.put(nextId, p)
      val r = closure(balances, ps, nextId + 1, now)
      if (r._2.get(nextId).status == "Queued" and queuedCount(r._2, nextId + 1) > QUEUE_CAP)
        rejected("QueueFull")
      else all {
        reserve' = reserve,
        commit(balances, ps, nextId + 1, nextId),
      }
    }

  // The guards that A5, A6 and A8 share: the id was issued, and the payment is queued.
  pure def queuedError(ps: int -> Payment, id: int): str =
    if (not(ps.keys().contains(id))) "UnknownPayment"
    else if (ps.get(id).status != "Queued") "NotQueued"
    else ""

  // A6: the sender revokes a queued payment (ADR-0016).
  action revoke(id: int): bool = {
    val e = queuedError(payments, id)
    if (e != "") rejected(e)
    else all {
      reserve' = reserve,
      commit(balances, payments.set(id, { ...payments.get(id), status: "Revoked" }), nextId, 0),
    }
  }

  // A8 with toEnd = false: the payment moves to the other queue, keeping its place by age.
  action reprioritise(id: int, priority: str): bool = {
    val e = queuedError(payments, id)
    if (e != "") rejected(e)
    else if (payments.get(id).priority == priority) rejected("SamePriority")
    else all {
      reserve' = reserve,
      commit(balances, payments.set(id, { ...payments.get(id), priority: priority }), nextId, 0),
    }
  }

  // A5 after ADR-0015: anyone rejects a queued payment past its expiry.
  action expire(id: int): bool = {
    val e = queuedError(payments, id)
    if (e != "") rejected(e)
    else if (now <= payments.get(id).submittedAt + EXPIRY) rejected("NotExpired")
    else all {
      reserve' = reserve,
      commit(balances, payments.set(id, { ...payments.get(id), status: "Expired" }), nextId, 0),
    }
  }

  // A19: time passes. No contract call is made, so nothing settles (C-DF-032).
  action tick(dt: int): bool = all {
    now' = now + dt,
    reserve' = reserve,
    balances' = balances,
    payments' = payments,
    nextId' = nextId,
    lastError' = "",
    lastValue' = 0,
    settledNow' = List(),
    offsetsNow' = List(),
    prevStatus' = statuses(payments),
  }

  action init = all {
    reserve' = BANKS.foldl(Map(), (m, b) => m.put(b, FUNDING)),
    balances' = BANKS.foldl(Map(), (m, b) => m.put(b, 0)),
    payments' = Map(),
    nextId' = 0,
    now' = 0,
    lastError' = "",
    lastValue' = 0,
    settledNow' = List(),
    offsetsNow' = List(),
    prevStatus' = Map(),
  }

  // One named action per contract call. Each picks its arguments with `nondet`, so
  // `--mbt` records them in `mbt::nondetPicks` and the action's name in
  // `mbt::actionTaken`.
  pure val BANK_SET = Set("A", "B", "C")

  action depositStep = {
    nondet bank = BANK_SET.oneOf()
    // Small deposits keep balances low, so that queues and offsets happen.
    nondet amount = 1.to(60).oneOf()
    deposit(bank, amount)
  }

  action withdrawStep = {
    nondet bank = BANK_SET.oneOf()
    nondet amount = 1.to(60).oneOf()
    withdraw(bank, amount)
  }

  action submitStep = {
    nondet bank = BANK_SET.oneOf()
    nondet payee = BANK_SET.oneOf()
    nondet amount = 1.to(80).oneOf()
    nondet priority = PRIORITIES.oneOf()
    submit(bank, payee, amount, priority)
  }

  // Mostly ids that exist, sometimes the next one, which was never issued.
  action revokeStep = {
    nondet id = 0.to(nextId).oneOf()
    revoke(id)
  }

  action reprioritiseStep = {
    nondet id = 0.to(nextId).oneOf()
    nondet priority = PRIORITIES.oneOf()
    reprioritise(id, priority)
  }

  action expireStep = {
    nondet id = 0.to(nextId).oneOf()
    expire(id)
  }

  action tickStep = {
    nondet dt = 1.to(EXPIRY + 2).oneOf()
    tick(dt)
  }

  action step = any {
    depositStep,
    depositStep,
    withdrawStep,
    submitStep,
    submitStep,
    submitStep,
    submitStep,
    revokeStep,
    reprioritiseStep,
    expireStep,
    tickStep,
  }

  // ---- Invariants (§4.7), checked with `quint run --invariants ...` ----

  def sumOf(m: str -> int): int = BANKS.foldl(0, (s, b) => s + m.get(b))

  // S1: no cash is created or destroyed. What the contract holds, which is FUNDING times
  // the banks less what they hold outside, equals the sum of the balances (ADR-0004).
  val S1_conservation = sumOf(reserve) + sumOf(balances) == FUNDING * BANKS.length()
  // S2: no credit line, so no balance or holding goes negative.
  val S2_noNegative = BANKS.foldl(true, (ok, b) => ok and balances.get(b) >= 0 and reserve.get(b) >= 0)
  // S3 and S5: a final status never changes, and a settlement time never moves.
  val S3_finalStaysFinal = prevStatus.keys().forall(i =>
    prevStatus.get(i) == "Queued" or prevStatus.get(i) == payments.get(i).status)
  // S7 (a), (b), and F2 and F6 for offsets: no payment the last call settled overtook a
  // payment of the same bank that is still queued and comes before it in ≺. Priorities
  // change only in A8's own effect, before the closure, so the post-state's priorities
  // are those the closure saw. A later demotion may leave an older payment queued behind
  // a settled one, so this is checked per call, not over the whole history.
  pure def precedes(q: Payment, p: Payment): bool =
    (q.priority == "Urgent" and p.priority == "Normal") or (q.priority == p.priority and q.id < p.id)
  val S7_fifo = settledNow.foldl(true, (ok, i) => ok and payments.keys().forall(j => {
    val p = payments.get(i)
    val q = payments.get(j)
    not(q.status == "Queued" and q.payer == p.payer and precedes(q, p))
  }))
  // S9: at rest, no bank has a covered head.
  val S9_atRest = BANKS.foldl(true, (ok, b) => ok and release(balances, payments, nextId, b) < 0)
  // S11: every payment is valid, and ids are its keys.
  val S11_validity = payments.keys().forall(i => {
    val p = payments.get(i)
    p.id == i and i < nextId and p.amount > 0 and p.payer != p.payee
  })
  // S23: between calls, no offset is feasible.
  val S23_eagerOffsetting = isZero(kstar(balances, payments, nextId))
  val queueBounded = queuedCount(payments, nextId) <= QUEUE_CAP
  val allInvariants = S1_conservation and S2_noNegative and S3_finalStaysFinal and S7_fifo and
    S9_atRest and S11_validity and S23_eagerOffsetting and queueBounded

  // ---- Witnesses: states the traces should reach, so the replay exercises them ----

  val W_offset = offsetsNow.length() > 0
  val W_queueFull = lastError == "QueueFull"
  val W_expired = payments.keys().exists(i => payments.get(i).status == "Expired")
  val W_revoked = payments.keys().exists(i => payments.get(i).status == "Revoked")
  // An urgent payment settled while an older normal one of the same bank still waits.
  val W_urgentOvertook = payments.keys().exists(i => payments.keys().exists(j => {
    val u = payments.get(i)
    val o = payments.get(j)
    u.status == "Settled" and u.priority == "Urgent" and o.status == "Queued" and
      o.priority == "Normal" and o.payer == u.payer and o.id < u.id
  }))
  val W_deepQueue = queuedCount(payments, nextId) >= 4
  val W_cascade = settledNow.length() >= 3
}
