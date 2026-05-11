# Changelog

## v0.5.0 — single-arbiter + appeal-of-3 redesign + audit pass (unreleased)

### Contract redesign

- Moved from a 3-panelist round-0 panel to **single-arbiter round 0,
  appeal-of-3** (spec frozen in `docs/arbitration-redesign.md`). Round 0
  draws one arbiter; if either party appeals, two more are drawn and the
  three-way median becomes the verdict.
- `Aegis.sol` rewritten end-to-end (~1488 lines vs the v0 ~1637 lines).
  Spec decisions D1–D16 are referenced inline in the contract.
- `policy` struct compacted: appeal-time parameters (`appealFeeBps`,
  `appealWindow`, `repeatArbiterCooldown`) merged in; ELCP appeal bonds
  removed in favor of escrow-fee-token appeal fees (D2).
- `forceCancelStuck` escape hatch (H-02) for VRF-stuck cases —
  governance-only, time-gated, can refund the escrow's fee deposit.

### Audit pass

In-house pre-audit on the redesigned contract — see
`docs/security-review-redesign.md`.

| ID | Severity | Status |
|---|---|---|
| H-01 | HIGH   | Fixed — pot-share floor on `perArbiterFeeBps` |
| H-02 | HIGH   | Fixed — `forceCancelStuck` escape hatch + 5 tests |
| M-01 | MEDIUM | Fixed — `_settleAppeal` pays both panelists pro-rata |
| M-02 | MEDIUM | Fixed — re-confirmed reentrancy guards on external call |
| M-03 | MEDIUM | Fixed — `_arbiterList` iteration cost notes added |
| M-04 | MEDIUM | Fixed — `recuse()` replacement draw mixes case salt |
| L-01..L-04 | LOW | Fixed |

Older `docs/security-review.md` (the v0 review) is superseded; its
trust assumptions still apply.

### Frontend de novo pass

- Case workspace rewritten so an assigned arbiter sees only the briefs,
  evidence, deadline, and commit/reveal form — never the panel listing,
  the timeline, prior verdicts, or any "original vs appeal" labeling
  (UX invariant #1 in `docs/ux-design.md`).
- Right-rail arbiter checklist (`<ArbiterChecklist>`) drives
  encryption-setup gating + commit / reveal / save-recovery-file steps.
- Sticky salt-recovery banner (`<SaltRecoveryBanner>`) for arbiters
  who've committed but haven't downloaded their recovery file.
- Appeal button (`<AppealButton>`) enforces D12 (full winners can't
  appeal) and now reads `appealFeeBps` from `policy()` on-chain rather
  than the spec-frozen default.
- New: `<EvidencePanel>`, `<EncryptedBriefViewer>`, `<ConfigureEncryption>`,
  `<CommitRevealForm>` (single unified form for original + appeal slots),
  `<CaseStatusBadge>` (renders generic "voting" labels for arbiters).

### E2E integration harness

- Playwright suite under `e2e/` boots a real `hardhat node`, an embedded
  postgres, deploys + seeds, and drives the wagmi UI through an injected
  `window.ethereum` shim.
- Specs: `smoke.spec.ts` (route snapshots, no chain), `ui-sign-in.spec.ts`
  (SIWE flow), `arbiter-happy-path.spec.ts` (commit/reveal end-to-end
  via the real keeper indexer).
- Base Sepolia fork integration test added (Hardhat) — exercises real
  external chain state against the redesigned contracts.

### Test coverage

- Hardhat: 28 specs in `Aegis.test.ts` + integration suites covering
  appeal flow (E3 partial-reveal, E4 full-fail), round-0 redraw,
  round-1 default, recusal + D13 cooldown + D12 full-winner exclusion.
- Vitest: 26 service-layer specs across SIWE, rate-limit, brief schema,
  and seal crypto round-trip.

### Arbiter self-profile

- New **Stake management** section on `/arbiters/[address]` when the
  signed-in wallet matches the address. Shows staked / locked / free
  ELCP per chain and exposes `<StakeForm>` (approve → stake) and
  unstake actions (guarded client-side against the lockedStake
  invariant in addition to the contract check).
- New **Pending claims** section listing every (chain, fee-token)
  the arbiter has a non-zero `claimable` balance for, with a
  `<ClaimButton>` per row.
- New `lib/arbiters/onchain.ts` reader for `lockedStake(arbiter)` and
  `claimable(arbiter, token)` — falls back to 0 on RPC failure.

### Layout — case workspace 2-column shell

- `app/cases/[id]/page.tsx` restructured into `main` + `aside`. The
  rail renders five cards (Closes in / You are / Case details / What
  to do / Need help?) for every viewer type. Round and panel size
  are suppressed in the rail for assigned arbiters (de novo
  blindness — they leak original-vs-appeal phase context).
- The old "Your vote" sub-grid that held `<ArbiterChecklist>` is
  gone; the checklist now lives in the rail's "What to do" card and
  serves party / observer roles with appropriate copy too.

### UX invariant pass

- **#1 de novo blindness** — original verdict + final digest are now
  hidden in the case-workspace rail when the viewer is an assigned
  arbiter and the case hasn't resolved. Previously an appeal arbiter
  would see the original arbiter's median in the rail's `Verdict`
  field, biasing them before commit.
- **#2 salt persistence** — the reveal form now loads the commit
  stash from `localStorage` on mount and surfaces a "paste recovery
  file" fallback when the stash is missing (different device).
  Accepts both the localStorage shape and the downloaded recovery
  JSON from `<SaltRecoveryBanner>`.
- **#3 deadline urgency** — countdown text color escalates zinc →
  amber (under 6h) → red (under 1h) so an arbiter doesn't need to
  parse the digits to feel the pressure.
- **#4 encryption gating** — `/queue` shows an unmissable amber
  banner ("You haven't set up your encryption key.") with a deep
  link to the arbiter profile when the signed-in wallet hasn't
  configured `arbiter_keys.encryptionPubkey`.
- **#5 verdict-as-percentage clarity** — the commit form swapped
  the bare number input for a range slider with `All A` / `All B`
  labels at the ends and a live `60 / 40` readout. Avoids the
  for/against framing the spec calls out as a footgun.
- New **YOUR STATUS** rail card surfaces the current phase
  prominently (`Commit phase` / `Reveal phase` / `Resolved` /
  `Awaiting panel` / `Appeal window`) with a color band, sanitized
  for arbiters so `appeal_*` collapses to `open` / `revealing` —
  same de novo rule as the status badge.

### Anonymity tightening

- Queue page drops the `Phase` column and passes `forArbiter` to the
  status badge — assigned arbiters no longer see "Original" /
  "Appeal" labeling or `appeal_*` status text. Matches
  `ux-design.md`'s "queue rows are intentionally undifferentiated"
  invariant.
- Case workspace's `Panel` and `Appeal panel` sections are now
  hidden from public observers while the case is in flight. Parties
  still see them; everyone sees them post-resolution. D13 anonymity.
- `assembleTimeline` withholds the panelist address from
  `panelist_*` events for public observers during flight (renders as
  `(hidden)` rather than the real address).
- `lib/policy.readAppealFeeBps` reads the fee from `policy()` on-chain
  instead of a hardcoded 250 bps; falls back to 250 if the RPC fails.

### Cases ledger + roster — spec column parity

- Ledger rows now include the disputed amount and the relative
  opened time, per `ux-design.md:250-252`.
- Roster rows now include the relative joined time, per
  `ux-design.md:442`.

### Hygiene

- Dropped unused `clsx` dependency.
- `import "server-only"` added to `lib/db/{client,schema}.ts`.
- `.gitignore` covers root-level `.local-pg-data/`, `screenshots-v2/`,
  `screenshots-v3/`.
- `pnpm e2e` and `pnpm e2e:smoke` scripts added.
- CI workflow (`.github/workflows/ci.yml`) runs typecheck, vitest,
  and the hardhat suite on push + PR.
- `docs/security-review.md` is banner-marked as superseded by
  `docs/security-review-redesign.md` (the v0 review's specific
  findings don't apply to the redesigned contract).

## v0.4.0 — encrypted evidence files (unreleased)

### Added
- **Encryption parity for evidence.** Same X25519+AES-GCM hybrid scheme
  used for briefs (`lib/crypto/seal.ts`) now applies to uploaded files
  in the evidence panel. Opt-in; client-side seal before upload.
- **Evidence storage gains `is_encrypted` + sealed-blob columns.**

### Notes
- Recipient set for an encrypted file = the case panel + the
  uploader. Panel changes after upload don't re-seal automatically; the
  uploader needs to re-upload to extend access.

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
