# e2e

Two test groups, both run via `pnpm exec playwright test`.

## smoke (`smoke.spec.ts`)

Route-level chrome screenshots — no DB, no chain. Boots the dev server,
visits 6 public routes, asserts the top-nav wordmark mounts, captures a
full-page PNG. Fast (under 30s), runs against any base URL.

```bash
pnpm exec playwright test smoke
```

## integration specs

Full integration — embedded postgres, real hardhat, real Aegis contract,
real SIWE auth, real wagmi UI flow via an injected `window.ethereum` shim.

### `arbiter-happy-path.spec.ts`

1. Inject `window.ethereum` (signs with the drawn arbiter's hardhat key).
2. Programmatic SIWE sign-in as the VRF-drawn arbiter.
3. Visit `/cases/:id`, assert de novo framing copy + "Open · commits" badge.
4. **Click "Commit vote"** — wagmi sends the tx through the injected wallet.
   Mirror the indexer's reaction into the DB.
5. Reload, assert the commit checklist hint flipped to "Recorded…".
6. `evm_increaseTime` past the commit window + flip cases.status in DB.
7. **Click "Reveal vote"** — wagmi reads the salt from localStorage.
8. Reload, assert "Appeal window" badge.

### `ui-sign-in.spec.ts`

Drives the SignInButton component through wagmi → injected wallet →
`personal_sign` → `/api/auth/verify`, asserts the iron-session cookie
lands and `/api/auth/me` confirms it.

### What's still NOT exercised

- The keeper indexer. State transitions are mirrored into the DB by
  small inline helpers in `helpers/db.ts`. Booting the keeper as a
  child process is blocked by `import "server-only"` in keeper modules
  (would need a custom Node loader to stub it). The keeper has full
  contract-side coverage in Hardhat tests; integration here is a
  separate scope.
- Briefs, evidence, encryption-key configuration — assumed wired up
  before the case is live; specs for those are TODO.
- Appeal flow (D2 fee pull, D12 winner-block, appeal panel of 3).
- Stall round-0 redraw, recuse, governance setPolicy.

### Prerequisites

A hardhat node must be running in another terminal:

```bash
pnpm contracts:node
```

Contracts must be compiled (`pnpm contracts:compile`) — the deploy helper
reads ABIs and bytecode out of `blockchain/artifacts/`.

The first run downloads a postgres binary (~5 MB) into `node_modules`.
Cached on subsequent runs.

### Running

```bash
# Terminal 1
pnpm contracts:node

# Terminal 2
pnpm exec playwright test arbiter-happy-path
```

### Architecture

- `global-setup.ts` — boots embedded postgres on port 54329, applies the
  drizzle schema, deploys Aegis + mocks against hardhat, opens a case,
  fulfills mock VRF, seeds DB, writes `e2e/.fixtures.json`.
- `global-teardown.ts` — stops embedded postgres.
- `helpers/`
  - `pg.ts` — embedded-postgres lifecycle + `drizzle-kit push`.
  - `deploy.ts` — viem-based contract deploy + arbiter registration +
    case seed + mock VRF fulfillment.
  - `wallet-inject.ts` — injects an EIP-1193 provider as `window.ethereum`
    so the wagmi `injected` connector picks it up. Signing is delegated
    to the test process via `page.exposeFunction`.
  - `siwe.ts` — programmatic SIWE sign-in (`signInAs(page, privateKey)`)
    when a spec doesn't need the UI sign-in flow.
  - `onchain.ts` — viem wrappers: `commitVote`, `revealVote`,
    `advanceTime`. Used when a spec needs to mutate state without
    going through the UI.
  - `db.ts` — direct postgres-js seeding + indexer-mirroring helpers
    (`seedOpenedCase`, `recordCommit`, `recordOriginalReveal`,
    `wipeDb`).
  - `fixtures.ts` — `e2e/.fixtures.json` reader/writer.

### Env contract

`global-setup.ts` mutates `process.env` so the dev server (started by
Playwright `webServer`) inherits:

| Var                                | Source                          |
|------------------------------------|---------------------------------|
| `DATABASE_URL`                     | embedded postgres URL           |
| `NEXT_PUBLIC_AEGIS_HARDHAT`        | deployed Aegis address          |
| `NEXT_PUBLIC_VAULTRA_ADAPTER_HARDHAT` | deployed MockArbitrableEscrow |
| `NEXT_PUBLIC_ELCP_HARDHAT`         | deployed MockERC20 (stake)      |
| `NEXT_PUBLIC_USDC_HARDHAT`         | deployed MockERC20 (fee)        |
| `NEXT_PUBLIC_HARDHAT_RPC_URL`      | `http://127.0.0.1:8545`         |
| `SESSION_PASSWORD`                 | deterministic test value        |

If the dev server is already running with different env, Playwright's
`reuseExistingServer` will reuse it — **stop and restart** the dev server
to pick up the new env, or unset `reuseExistingServer` for the run.

### Known caveats

- **Root users**: `embedded-postgres` refuses to run as root (postgres
  itself does — `initdb` exits with a permission error). Run the suite
  as a normal user. Containers / sandboxes that enforce root will need
  a non-root user added before `pnpm exec playwright test` will work.

### Adding new specs

Each test should call `wipeDb` + `seedOpenedCase` (or its own seeder) in
`beforeEach` to keep tests independent. The single-worker config means
sequential execution is the default; parallelization would need
per-test schemas or per-test pg databases.
