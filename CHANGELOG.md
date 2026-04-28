# Changelog

## v0.1.0 — initial v1 (unreleased)

### Contracts

- `Aegis.sol` — court contract holding ELCP stake and routing
  arbitration fees. AccessControl with `GOVERNANCE_ROLE` (Eclipse DAO).
- `IArbitrableEscrow.sol` — minimal interface that any escrow protocol
  implements to plug into Aegis.
- `VaultraAdapter.sol` — IArbitrableEscrow shim for `VaultraEscrow`.
  Routes between Aegis's opaque `caseId` and Vaultra's
  `(escrowId, milestoneIndex)` pair, and forwards the arbitration fee
  Vaultra pays it on to Aegis.
- Mocks: `MockERC20`, `MockArbitrableEscrow` for hardhat tests.

### Court features

- ELCP-staked arbiter registry, governance-managed.
- `lockedStake[arbiter]` mapping to prevent unstake-mid-case slash dodge.
- Pseudorandom panel selection (`prevrandao` + `caseId`) excluding
  parties and over-booked arbiters.
- Commit-reveal voting; `hashVote(...)` view exposes the on-chain hash
  contract.
- Median resolution with EIP-712 final digest passed back to the escrow.
- Two-round timeout fallback: round 0 stall slashes non-revealers and
  redraws; round 1 stall settles 50/50 deterministically.
- Self-recusal during commit phase (`recuse(caseId)`) with automatic
  replacement panelist draw.
- Bond-only slashing — non-revealers lose exactly `stakeRequirement`
  per case, capped at remaining stake.
- Pull-pattern fee distribution: 80% to revealing panelists (equal
  share), 20% to a governance-controlled treasury, dust to treasury.
- Governance levers: `registerArbiter`, `revokeArbiter`, `setPolicy`,
  `setNewCasesPaused`, `withdrawTreasury`.

### Off-chain

- Drizzle + Supabase schema: `cases`, `panel_members`, `briefs`,
  `rationales`, `arbiters`, `siwe_nonces`, `indexer_state`.
- SIWE auth ported from Vaultra (`lib/auth/`).
- Cases service with idempotent indexing keyed by
  `(chainId, aegisAddress, caseId)` and party/panelist-aware brief
  visibility rules.
- Keeper (`scripts/keeper.ts`) doing three things per tick:
  1. Bridge: scan Vaultra `DisputeRaised` logs and call
     `VaultraAdapter.registerCase` + `Aegis.openDispute`.
  2. Mirror: scan Aegis events and update DB rows for cases, panels,
     briefs, arbiters, and stake balances.
  3. Auto-finalize: call `Aegis.finalize` on cases whose reveal +
     grace windows have closed but DB still says in-flight.
- Local-dev `contracts:deploy:local` script: deploys + funds + seeds in
  one command, prints `.env.local` lines.

### Frontend

- Next.js 14 App Router app on port 3457.
- Public `/cases` ledger.
- Per-case workspace `/cases/[id]` with brief editor (parties),
  panelist commit-reveal form, recusal button, post-resolution brief
  visibility.
- `/arbiters` roster mirror.
- `/governance` proposal-calldata builder for Eclipse DAO.
- `/admin` ops dashboard — keeper cursors, lag, case backlog,
  stuck-case warning.

### Documentation

- `docs/integration-vaultra.md` — wiring Vaultra in.
- `docs/integration-newdapps.md` — adding a new escrow protocol.
- `docs/security-review.md` — pre-audit threat model + findings.
- `CLAUDE.md` — working notes for future Claude sessions.

### Security findings addressed

| ID | Severity | Description |
|---|---|---|
| F-01 | HIGH | Unstake-mid-case dodge — fixed via `lockedStake` mapping |
| F-02 | LOW | `stake()` CEI ordering tightened |
| F-03 | MEDIUM | First-quorum finalize — gated on all-revealed-or-window-expired |
| F-04 | INFO | Recusal mechanism added (partial fix for D-04) |
| F-05 | LOW | Slash now forfeits the case bond, not 50% of total stake |
| F-06 | MEDIUM | `openDispute` dedup via `liveCaseFor` — twin keepers can't fork a case |
| F-07 | MEDIUM | Chainlink VRF panel selection — closes the last validator-manipulability vector |

### Known issues / deferred to v2

- D-04 LOW (residual): undisclosed COIs not detected on-chain.
- D-05 LOW: panel-draw gas grows linearly with arbiter pool size.
- V-01: appeals layer.
- V-07: encrypted briefs.
- V-08: cross-chain dispute coordination.

### Test coverage

- 37 Hardhat specs (Aegis unit + Vaultra integration).
- 10 vitest unit tests (auth nonce TTL, brief schema).
- `pnpm build` produces clean production assets across 13 routes.

### Decisions locked from the design plan

- Stake denomination: **ELCP** (Eclipse's native ERC20Votes token).
- Appeals: **deferred to v2.**
- Repo / contract name: **Aegis.**
