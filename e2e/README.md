# e2e

Two test groups, both run via `pnpm exec playwright test`.

## smoke (`smoke.spec.ts`)

Route-level chrome screenshots — no DB, no chain. Boots the dev server,
visits 6 public routes, asserts the top-nav wordmark mounts, captures a
full-page PNG. Fast (under 30s), runs against any base URL.

```bash
pnpm exec playwright test smoke
```

## arbiter happy path (`arbiter-happy-path.spec.ts`)

Full integration — embedded postgres, real hardhat, real Aegis contract,
real SIWE auth.

### What it exercises

1. Programmatic SIWE sign-in as the arbiter that VRF assigned.
2. Navigate to `/cases/:id`, assert the de novo framing copy ("Case at
   arbitration", "You have been randomly selected…") and the "Open · commits"
   status badge.
3. `commitVote` on-chain via viem; mirror the indexer's reaction in the
   DB (panel_members.committedAt + commit_hash).
4. Reload, assert the commit checklist item flips to its checked state.
5. `evm_increaseTime` past the commit window.
6. `revealVote` on-chain via viem; mirror the indexer's reaction in the
   DB (cases.status = `appealable_resolved`).
7. Reload, assert the "Appeal window" badge.

### What it does NOT exercise

- The wagmi UI commit/reveal buttons — `commitVote` / `revealVote` are
  issued from the test process directly. Driving the buttons requires
  injecting a window.ethereum EIP-1193 mock; that's a follow-up.
- The keeper indexer. State transitions are mirrored into the DB by
  small inline helpers in `helpers/db.ts`. The keeper has its own
  contract-side coverage in Hardhat tests; integrating it here is a
  separate scope.
- Briefs, evidence, encryption-key configuration — assumed wired up
  before the case is live; specs for those are TODO.

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
  - `siwe.ts` — programmatic SIWE sign-in (`signInAs(page, privateKey)`).
  - `onchain.ts` — viem wrappers: `commitVote`, `revealVote`,
    `advanceTime`. Includes the same keccak hash math the contract
    uses for commits.
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
- **wagmi UI flow**: commit/reveal buttons aren't clicked. The transactions
  are issued from the test process. Adding a `window.ethereum` mock in
  `page.addInitScript` would let us drive the UI directly.

### Adding new specs

Each test should call `wipeDb` + `seedOpenedCase` (or its own seeder) in
`beforeEach` to keep tests independent. The single-worker config means
sequential execution is the default; parallelization would need
per-test schemas or per-test pg databases.
