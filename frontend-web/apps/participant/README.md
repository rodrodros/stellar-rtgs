# @rtgs/participant

A participant's (a bank's) app for the RTGS settlement contract. It runs on the devnet, testnet or (opt-in) mainnet. A bank uses it to:
- move cash tokens between its trustline and its settlement balance (`deposit`, `withdraw`), and open its trustline;
- submit payment orders and see whether each settled at once or queued;
- revoke (ADR-0016) or reprioritise (ADR-0009) its queued payment orders;
- watch its urgent and normal queues: the head, what blocks it, and each order's expiry (ADR-0015);
- follow its intraday credit and repos, and repay them (ADR-0011, ADR-0014);
- see incoming settlements live, from core's event feed.

All chain access goes through `@rtgs/core`; the app holds UI and UI state only.

## Run

```sh
pnpm install
IMPL_NAME=impl-fe-bank IMPL_PORT=8360 make -C ../../../stellar-implementation devnet-up
RTGS_DEVNET_RPC_URL=http://localhost:8360/rpc pnpm devnet:bootstrap   # from the workspace root
VITE_RTGS_DEVNET_RPC_URL=http://localhost:8360/rpc pnpm -F @rtgs/participant dev
```

The app serves on port 5175. Settings come from `VITE_RTGS_*` env vars (see `../../.env.example` and `packages/core/README.md`), and the "Deployment settings" panel overrides the RPC URL, contract id and central bank per network at runtime.

- **Devnet:** "Act as" switches between the demo banks with one click. `?bank=2` pins a tab to Bank 2, so a demo can open one tab per bank. The choice is per tab.
- **Testnet and mainnet:** "Connect wallet" opens Stellar Wallets Kit.
- **Mainnet** is listed only with `VITE_RTGS_ENABLE_MAINNET=true`. Selecting it asks you to type `mainnet`, and a red banner stays up while it's active. The app never starts on it.
- **Stubs:** core probes each entry point. Where `credit`, `repo` or `repay` is still a stub, the credit section says so and disables repayment. The expiry line changes once `expire` is implemented.

## Tests

```sh
pnpm -F @rtgs/participant test        # unit and component tests, on an in-memory fake session
RTGS_DEVNET_RPC=http://localhost:8360/rpc pnpm -F @rtgs/participant test:e2e
```

The e2e test bootstraps a fresh deployment from a new seed, then drives two copies of the app, Bank 1 and Bank 2, against the devnet:
1. Bank 1 deposits and settles a payment at once.
2. It queues an uncovered payment behind a blocked head, reprioritises it, then revokes it.
3. It queues another payment and deposits enough to cover it. The eager closure settles it, and Bank 2 sees the incoming settlement without a refresh.

It skips itself when no devnet answers. It runs in Node with a jsdom window installed by `e2e/dom.ts`, because Vitest's jsdom environment breaks the Stellar SDK's byte checks.

## Layout

| Path | Contents |
|---|---|
| `src/App.tsx` | Network switch, connection, deployment settings |
| `src/session/` | The acting bank (devnet identity or wallet), the bank's views, capability helpers |
| `src/connect/` | Network switcher with the mainnet confirmation, the "Act as" bar, deployment settings |
| `src/liquidity/`, `src/payments/`, `src/queues/`, `src/credit/` | The dashboard's panels |
| `src/live/` | Which events concern the bank, and the incoming-settlement notices |
| `src/ui/` | Formatting, the write flow (`useTx`), badges, the confirm dialog |
| `src/test/fakeSession.ts` | An in-memory core session for component tests |
