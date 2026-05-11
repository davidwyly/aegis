# Aegis — working notes for Claude

Sibling repo to `/home/dwyly/code/vaultra`. Eclipse-DAO-administered
arbitration court. The architectural rationale lives in
`/home/dwyly/.claude/plans/critically-evaluate-vaultra-it-s-logical-volcano.md`;
the threat model lives in `docs/security-review.md`.

## Stack at a glance

- Next.js 14 App Router, React 19, wagmi v2 + viem 2 — matches Vaultra
- Solidity 0.8.24 + Hardhat — contracts in `blockchain/`
- Drizzle ORM + Supabase Postgres — schema in `lib/db/schema.ts`
- SIWE + iron-session — ported from Vaultra's `lib/auth/`
- vitest (pure logic) + Hardhat (contracts) + Playwright (integration
  harness with embedded postgres + local hardhat node; see `e2e/`)

## Layout

```
/                         Next.js app
/blockchain               Hardhat sub-project (contracts + tests + ignition)
/app/api                  SIWE auth, cases, briefs, arbiters, admin/status
/app/cases                Public ledger + per-case workspace
/app/arbiters             Roster mirror (DB → on-chain)
/app/governance           Eclipse DAO calldata builder
/app/admin                Ops dashboard — keeper cursors, case backlog
/lib/auth                 SIWE + iron-session helpers
/lib/db                   Drizzle schema, lazy client
/lib/cases                Idempotent case indexing + brief access control
/lib/keeper               Vaultra→Aegis bridge + Aegis event mirror + auto-finalize
/lib/admin                Read-only ops snapshot
/lib/abi                  Auto-exported from Hardhat artifacts (do NOT hand-edit)
/lib/chains.ts            Per-chain Aegis/adapter/Vaultra/ELCP addresses
/lib/web3.ts              Single wagmi config
/scripts                  ABI export + keeper CLI entrypoint
/blockchain/contracts/integration-fixtures   Vendored copy of VaultraEscrow.sol
/docs                     integration-vaultra, integration-newdapps, security-review
```

## Typechecking

- Use `pnpm typecheck`. Cold runs on this repo are 30-60s on WSL2; the
  script pins `--incremental` so warm runs are 3-5s.
- **Don't typecheck after every small edit.** LSP diagnostics during
  editing catch most things; reserve `tsc` for "is the build clean" gates.
- After contract changes, also run `pnpm contracts:export-abi` so the TS
  ABI files in `lib/abi/` stay in sync with the artifact.

## Long-running commands

- `pnpm test` (vitest), `pnpm contracts:test`, `pnpm build`,
  `pnpm typecheck`, `pnpm contracts:compile` are all >30s candidates —
  run with `run_in_background: true`. Don't pipe to `head`/`tail` and
  block on it; the pipe close can SIGPIPE the parent.
- The default Bash timeout is 2 minutes. Background jobs are the escape
  hatch, not longer timeouts.
- After a background command completes, use `cat <output>` rather than
  `tail` to avoid that SIGPIPE class of bug.

## Path quirks

- `pnpm 10` does NOT accept `pnpm -C blockchain <subcmd>` the way pnpm 9
  did — the `-C` arg gets reinterpreted as a subcommand name. The
  `package.json` scripts use `cd blockchain && pnpm exec ...` instead.
  Don't "fix" this back to `-C`.
- The default working directory for shell commands persists between
  Bash tool calls. After `cd vaultra` you stay there. Use absolute
  paths or `cd /home/dwyly/code/aegis &&` if you want to be safe.

## Common tasks

```bash
# Local-dev bring-up — three terminals
pnpm contracts:node                 # 1. local hardhat node
pnpm contracts:deploy:local         # 2. deploys + seeds, prints env vars
pnpm dev                            # 3. http://localhost:3457

# Contract change loop
pnpm contracts:compile              # rebuilds artifacts
pnpm contracts:export-abi           # syncs lib/abi/*.ts
pnpm contracts:test                 # 37 tests
pnpm typecheck                      # confirm app side still types

# Keeper (cron)
KEEPER_PRIVATE_KEY=0x... \
KEEPER_CHAIN_ID=84532 \
KEEPER_RPC_URL=https://sepolia.base.org \
pnpm keeper

# DB
pnpm db:push                        # apply schema
pnpm db:studio                      # GUI
```

## Conventions to keep

- `import "server-only"` at the top of any module that touches the DB
  or holds secrets — EXCEPT keeper modules (`lib/keeper/*`). The keeper
  is also imported from Node-side test harnesses and from `scripts/keeper.ts`,
  neither of which run inside Next's RSC environment. Vitest aliases
  `server-only` to a no-op via `test/stubs/` for everything else.
- Use `recordCaseOpened` (idempotent via `(chainId, aegisAddress, caseId)`)
  for any new case-import path. Don't insert into `cases` directly.
- All keeper steps are idempotent and use the `indexer_state` cursor
  table to avoid replaying old blocks. New event handlers belong in
  `lib/keeper/aegis-indexer.ts`, not in raw Aegis service code.
- For pages that read the DB, set
  `export const dynamic = "force-dynamic"` so Next doesn't prerender
  them at build time with a stale "DB unavailable" UI.

## What NOT to do

- Don't edit `lib/abi/*.ts` by hand — they're auto-generated.
- Don't add per-test DB integration without a real plan; vitest currently
  covers pure logic only and aliases `server-only` to a stub.
- Don't change `arbiterList` storage layout — `lockedStake` is a separate
  mapping precisely so the existing layout stays additive.
- Don't introduce `pnpm -C blockchain ...` script forms — pnpm 10 breaks
  on those (see Path quirks).
- Don't run `pnpm dev` from the CLI to "test the UI." It just sits
  waiting for browser connections; you can't observe it. If the user
  wants visual verification they need to do it.
