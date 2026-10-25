# @rtgs/simulator

A headless simulation for the devnet. Once the devnet is set up, it keeps the banks transacting with each other until you stop it. The central bank, participant and observer apps then always have live traffic to show. It is a Node CLI on `@rtgs/core`, with no UI of its own.

```sh
make -C ../stellar-implementation devnet-up   # the local network
pnpm devnet:bootstrap                         # the contract, the cash token and 3 funded banks
pnpm simulate                                 # runs until Ctrl-C
pnpm dev                                      # in another terminal: watch it in the apps
```

Ctrl-C stops it gracefully:
1. it stops starting new actions and waits for the transactions already in flight;
2. it undoes anything left half done (a trustline it deauthorized is reauthorized);
3. it prints a summary.

A second Ctrl-C exits at once.

## What it does

Each bank, and the central bank, has a lane. A lane sends one transaction at a time, because two from the same account would collide on its sequence number. The lanes run side by side. Every tick, a policy picks something for each idle lane, among the operations that apply right now:

| Who | Operations |
|---|---|
| Each bank | `deposit`, `withdraw`, `submit` (urgent or normal), `revoke`, `reprioritise`, `repay` its repos |
| Central bank, credit | `setCollateral`, `openRepo` (minted into the contract), `repay` on a bank's behalf |
| Central bank, cash token | `issue` a top-up when a bank's trustline runs low, `clawback` when it holds a lot, `deauthorize` a trustline for a while, then `reauthorize` it |

A `submit` takes one of three shapes:
- **covered**: it settles at once;
- **uncovered**: it queues until a deposit or a repo releases it through the eager closure;
- **gridlock**: it crosses a queued payment order the other way, so the LSM offset settles both.

Uncovered submits stop while the central queue is within `queueHeadroom` of `queueCap`.

Credit actions run only while the contract implements them (the capability probe); the current Wasm does. Keeper actions are left to the central bank app's auto-keeper: `expire` and `convertOverdue`.

## Flags

```
--rpc <url>            devnet RPC (default: RTGS_DEVNET_RPC_URL, else http://localhost:8300/rpc)
--seed <seed>          devnet identity seed, as given to the bootstrap
--banks <n>            banks bank-1..n to drive (default 3)
--contract <id>        settlement contract (default: discovered from the central bank)
--profile <name>       balanced | gridlock | calm (default balanced)
--rate <n>             actions per second, across all lanes (default 2)
--rng-seed <n>         repeat a run's choices (default random, printed at start)
--max-actions <n>      stop after n actions
--duration <secs>      stop after this many seconds
--log <format>         pretty | json (default pretty)
--summary-every <secs> seconds between summaries, 0 for none (default 30)
```

Use the same `--rpc` and `--seed` as the bootstrap. Bootstrap the number of banks you simulate: `pnpm devnet:bootstrap --banks 5`, then `pnpm simulate --banks 5`.

The profiles:
- **`balanced`**: the default. Mostly covered payments, regular queueing, some credit, and an occasional clawback or deauthorization.
- **`gridlock`**: queues, eager closure and offsets.
- **`calm`**: covered payments, deposits and withdrawals only.

## Reading the output

**One line per action.** It shows the lane and what it tried, then one of three outcomes:
- `ok`, with the transaction hash and what followed: settled at once, queued, eager closure released #ids, offset of #ids, repo opened;
- `refused`, an expected race: the eager closure settled a payment order between the plan and the transaction, or another lane spent the balance;
- `FAILED`: anything else. A healthy run has none, or almost none.

**A summary every 30 s.** It shows:
- the pace and the queue against its cap;
- every bank's settlement balance, trustline holding and queues;
- the repos outstanding;
- the conservation check (S1): the cash the contract holds against the sum of the settlement balances, read from one ledger in one call;
- a warning if a lane's XLM for fees runs low. Friendbot doesn't refund an existing account, so a very long run can run out.

**`--log json`** prints the same facts as one JSON object per line.

## Contention

Lanes that simulate in the same ledger all predict the same next payment id. The contract's eager closure also reads the queues, so a transaction prepared before another lane's transaction lands can touch storage its footprint doesn't include. The network then rejects it. Core reports this as "State changed", and the engine prepares and sends it again, up to five times.

This is a property of the contract under concurrent use, not a simulator bug. Submissions from different banks effectively serialise per ledger. On a busy run a few still give up after five tries and are counted as `FAILED`.

## Layout

| Path | What |
|---|---|
| `src/types.ts` | The contracts every part meets at |
| `src/engine/` | Lanes, the loop and its rate budget, retries, outcome classification, stop and recover |
| `src/world/` | The live view: the session's store plus each bank's trustline |
| `src/actions/` | The operations: `payments.ts`, `credit.ts`, `token.ts` |
| `src/policy/` | Weighted choice, profiles, tuning, flag parsing |
| `src/report/` | Log lines, counters, summaries |
| `src/cli.ts` | Wiring and signals |

```sh
pnpm --filter @rtgs/simulator typecheck
pnpm vitest run --project simulator
```
