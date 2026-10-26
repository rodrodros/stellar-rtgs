# @rtgs/simulator

A headless simulation for the devnet. Once the devnet is set up, it keeps the banks transacting with each other until you stop it. The central bank, participant and observer apps then always have live traffic to show. It is a Node CLI on `@rtgs/core`, with no UI of its own.

```sh
make -C ../backend-soroban devnet-up   # the local network
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
| Central bank, keeper | `expire` a queued payment order past its expiry, `convertOverdue` a repo past its term |

A `submit` takes one of three shapes:
- **covered**: it settles at once;
- **uncovered**: it queues until a deposit or a repo releases it through the eager closure;
- **gridlock**: it crosses a queued payment order the other way, so the LSM offset settles both.

Uncovered submits stop while the central queue is within `queueHeadroom` of `queueCap`.

Credit and keeper actions run only while the contract implements them (the capability probe); the current Wasm does. Keeper actions only apply once something is due, a day into a run on the bootstrap's config. Don't turn on the central bank app's auto-keeper while the simulator runs: both sign as the central bank, and their transactions would collide on its sequence number.

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
--refuel-below <xlm>   refuel a lane from friendbot below this much XLM, 0 for never (default 2000)
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
- every lane's XLM, what it has spent per hour since the first summary, and the refuels so far;
- a warning if a lane's XLM for fees runs low, which with refuelling on means refuels are failing.

**A `refuel` line** when a lane is topped up, or fails to be.

**`--log json`** prints the same facts as one JSON object per line.

## Running for days

The simulator is built to run unattended on a hosted devnet.

**XLM for fees.** Every lane pays its own fees, and friendbot funds an account once. Once a minute the simulator reads every lane's XLM and refuels any below `--refuel-below`: friendbot funds a throwaway account, which merges into the lane (about 10,000 XLM). The throwaway account is the merge's source, so a refuel never touches the lane's sequence number and runs beside the traffic. At the default rate a lane spends some 15–25 XLM an hour; the summary's `xlm` line shows the actual rate.

**Status for the apps.** The simulator publishes what it is doing as a data entry on the central bank's account, `rtgs.sim`:
- `running:<ledger time>` at start, then again every minute as a heartbeat;
- `stopping:<t>` when a stop begins, `stopped:<t>` once it has drained.

The observer reads it every 15 seconds. It labels a running simulation beside the feed, and shows a banner when the simulation is paused, when it is running but quiet, or when its heartbeat is more than 3 minutes old (it died without saying so). The write goes through the central bank's lane, one classic transaction a minute.

**Timeouts.** Every RPC request gives up after 30 s (core's `RPC_TIMEOUT_MS`), and any action still unsettled after 2 minutes is counted `FAILED` and frees its lane, so a request the network never answers can't freeze a lane or the event feed.

**Supervision.** `pnpm simulate:supervised [flags]` runs `pnpm simulate` with these flags and starts it again whenever it exits: a crash, an RPC that wasn't up at start, or the end of a `--duration` (so `--duration 43200` recycles the process every 12 hours). It waits 10 s before a restart, doubling up to a minute while runs keep failing at once. Ctrl-C or SIGTERM stops the simulation gracefully, then the supervisor. In a container, run the supervisor as the entry point, or run `pnpm simulate` under a `restart: unless-stopped` policy.

```sh
pnpm simulate:supervised --rpc https://devnet.example/rpc --rate 2
```

## Contention

Lanes that simulate in the same ledger all predict the same next payment id. The contract's eager closure also reads the queues, so a transaction prepared before another lane's transaction lands can touch storage its footprint doesn't include. The network then rejects it. Core reports this as "State changed", and the engine prepares and sends it again, up to five times.

This is a property of the contract under concurrent use, not a simulator bug. Submissions from different banks effectively serialise per ledger. On a busy run a few still give up after five tries and are counted as `FAILED`.

## Layout

| Path | What |
|---|---|
| `src/types.ts` | The contracts every part meets at |
| `src/engine/` | Lanes, the loop and its rate budget, retries, outcome classification, stop and recover |
| `src/world/` | The live view: the session's store plus each bank's trustline |
| `src/actions/` | The operations: `payments.ts`, `credit.ts`, `token.ts`, `keeper.ts` |
| `src/policy/` | Weighted choice, profiles, tuning, flag parsing |
| `src/report/` | Log lines, counters, summaries |
| `src/fuel.ts` | Refuelling lanes from friendbot |
| `src/status.ts` | The status the apps show, and its heartbeat |
| `src/cli.ts` | Wiring and signals |
| `scripts/supervise.sh` | Restart on exit, for unattended runs |

```sh
pnpm --filter @rtgs/simulator typecheck
pnpm vitest run --project simulator
```
