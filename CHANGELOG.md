# Changelog

## v0.3.0 — encrypted briefs (unreleased)

### Added
- **Hybrid encryption for briefs.** Optional opt-in. AES-256-GCM
  for the body, X25519 ECDH + HKDF-SHA256 wrapping the AES key
  per recipient. End-to-end client-side; the server only sees
  ciphertexts.
- **Deterministic keypair derivation.** Each arbiter / party signs
  a fixed registration message (`Aegis encryption key v1`) once;
  `sha256(signature)` becomes the X25519 private key. Same wallet
  on a different device re-derives the same keypair with another
  signature.
- **`arbiter_keys` table.** Stores `(address, pubkey, signature,
  registeredAt)`. The signature is verified server-side against
  the claimed address via `viem.recoverMessageAddress` AND the
  pubkey is verified to match what `deriveX25519Keypair(signature)`
  produces, so an attacker can't post someone else's signature
  with their own pubkey.
- **`POST /api/arbiters/me/pubkey`** for self-registration,
  **`GET /api/arbiters/keys?address=...`** for bulk lookup (max
  100 per request).
- **`<ConfigureEncryption>` widget** on the arbiter profile page
  — only the owner can configure; sees existing pubkey if any.
- **`<BriefEditor>` opt-in toggle.** When checked, the editor
  fetches recipient pubkeys (panelists + author), seals the body
  to all of them, and POSTs `{ sealed }` instead of `{ body }`.
  Refuses to encrypt if any recipient hasn't configured.
- **`<EncryptedBriefViewer>`** client component. Tries the cached
  private key in `localStorage` first; if missing, prompts a
  signature, derives the key, decrypts. Falls back to a "Connect
  wallet" prompt for non-recipients.
- **`briefs.is_encrypted` + `sealed jsonb`** columns. Encrypted
  briefs do NOT version (the ciphertext changes per save because
  of fresh nonces, so structural equality isn't meaningful).

### Crypto deps
- `@noble/curves`, `@noble/ciphers`, `@noble/hashes` — small,
  audited, zero-runtime-deps. ~30kb total bundle.

### Tests
- 8 vitest specs covering keypair determinism, multi-recipient
  round-trip, non-recipient rejection, body / wrapped-key
  tamper detection, pubkey-matches-signature.
- 23 vitest passing (was 15).

### Notes
- Encrypted briefs are NOT versioned in v1 alpha. Plaintext
  briefs continue to version normally.
- Panel changes (recusal / redraw) don't auto re-encrypt to the
  new panelist. Author would need to re-save the brief — they'll
  see the new panel in BriefEditor and the encrypt-and-save
  button refreshes recipients automatically.
- The decrypt UX caches private keys in localStorage per address
  to avoid re-prompting. Standard wallet-derived-key model;
  identical to many e2ee dapps.

## v0.2.0 — appeals layer (unreleased)

### Added
- **Appeals (option 1, same-court).** Verdicts now stage in
  `AppealableResolved` for `policy.appealWindow` (default 7 days).
  Either party can call `requestAppeal(caseId)` within the window
  by posting an ELCP bond (default 2× stakeRequirement). VRF picks
  a larger appeal panel (default 5) excluding the original panel;
  they re-arbitrate via the same commit-reveal pattern
  (`appealCommitVote`, `appealRevealVote`).
- **Verdict comparison with tolerance.** If the appeal panel's median
  is within `policy.appealOverturnTolerance` percentage points (default
  5) of the original, the original verdict is *upheld* — bond pays the
  appeal panel + treasury, original panel paid normally from escrow fee.
  If outside tolerance, the verdict is *overturned* — original panel
  slashed (one bond each), appellant's bond refunded, the appeal verdict
  applies to the underlying escrow, and the appeal panel takes both the
  slashed amount and the escrow fee.
- **Stall handling.** Appeal panel stall ⇒ slash non-revealers,
  forfeit bond to treasury, settle the original verdict. No
  recursive appeals.
- **Eligibility prechecks.** `requestAppeal` rejects fast if the
  eligible pool can't seat the appeal panel size, before taking the
  bond or paying VRF gas.
- **8 new events** + **5 new errors** for the appeal flow.
- **Frontend `AppealButton`** on the per-case page when status is
  `appealable_resolved` and the viewer is a party.
- **DB schema** gains 4 case-status enum values; indexer handles the
  appeal-stage transitions.
- **Governance form** (`/governance`) now sets all four appeal
  parameters.

### Tests
- 5 new hardhat specs (file-within-window, non-party reject, late-window
  reject, upheld path, overturned path).
- 43 hardhat passing total (was 38).

### Notes
- Settlement now lags 7 days behind the original panel verdict for
  cases that aren't appealed. Cost of having appeals at all; tunable
  via `policy.appealWindow`.
- Recuse path keeps the prevrandao seed (panelist-initiated, not
  pre-targetable). Only `openDispute`, `_stallAndRedraw`, and
  `requestAppeal` use VRF.

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
