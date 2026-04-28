# Plugging Vaultra into Aegis

This is the one-pager. The Aegis-side rationale lives in the design plan;
this doc is just the pragmatic checklist.

## What you need before you start

- A deployed **Eclipse DAO `Governance.sol`** address on the target
  chain. Aegis grants this address `DEFAULT_ADMIN_ROLE` +
  `GOVERNANCE_ROLE` at construction. All registry / policy changes
  flow through DAO proposals.
- A deployed **ELCP token** on the target chain. Stake is denominated
  in this token; arbiters bond it via `Aegis.stake(amount)`. ELCP is
  also the token used for appeal bonds.
- A deployed **VaultraEscrow** instance whose owner you control
  (you'll point its `eclipseDAO` slot at the adapter you're about to
  deploy).
- A **live Chainlink VRF subscription** on the target chain, funded
  with LINK. Required — `openDispute` and the appeal flow both call
  `IVRFCoordinator.requestRandomWords`. If the subscription is empty
  or the coordinator is misconfigured, both revert. After deploying
  Aegis, add it as a consumer of the subscription on the Chainlink
  VRF dashboard.
  - Base mainnet coordinator: `0xd5D517aBE5cF79B7e95eC98dB0f0277788aFF634`
  - Base Sepolia coordinator: `0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE`
  - Pick a key hash + min confirmations from
    https://docs.chain.link/vrf/v2/subscription/supported-networks

## Deploy order

```bash
# 1. Aegis
cd blockchain && pnpm exec hardhat ignition deploy ignition/modules/Aegis.ts \
  --network baseSepolia \
  --parameters '{
    "Aegis": {
      "governance":         "0x<eclipse-governance>",
      "stakeToken":         "0x<elcp-token>",
      "treasury":           "0x<eclipse-treasury>",
      "vrfCoordinator":     "0x<chainlink-coordinator-on-this-chain>",
      "vrfKeyHash":         "0x<gas-lane-key-hash>",
      "vrfSubscriptionId":  "<sub-id>"
    }
  }'

# 2. Add the deployed Aegis as a consumer of your VRF subscription
#    on the Chainlink VRF dashboard. Aegis can't request randomness
#    until this is done.

# 3. VaultraAdapter (pointing at the Aegis you just deployed)
cd blockchain && pnpm exec hardhat ignition deploy ignition/modules/VaultraAdapter.ts \
  --network baseSepolia \
  --parameters '{
    "VaultraAdapter": {
      "aegis":   "0x<aegis>",
      "vaultra": "0x<vaultra>"
    }
  }'

# 4. Wire Vaultra to point new escrows' default arbiter at the adapter.
#    (Vaultra owner only; not the deployer of this repo.)
cast send <vaultra> "updateEclipseDAO(address)" <adapter>
```

Existing Vaultra escrows keep their original arbiter. Only
freshly-created ones default to the adapter.

## Onboard arbiters

Submit Eclipse DAO proposals targeting
`Aegis.registerArbiter(addr, ipfsCID)`. The `app/governance` page
generates the calldata.

Each registered arbiter then:

```ts
// 1. Stake ELCP
await elcp.approve(aegisAddress, stakeRequirement)
await aegis.stake(stakeRequirement)

// 2. (Optional) Configure encryption — visit /arbiters/<my-address>,
//    click "Configure encryption", sign the registration message.
//    Only required if you want to be able to receive encrypted briefs.
```

Arbiters whose `stakedAmount` falls below `policy.stakeRequirement`
are skipped on future panel draws but stay on already-assigned panels
until those resolve.

## What the keeper does

`scripts/keeper.ts` polls Vaultra's `DisputeRaised` /
`DisputeRaisedNoMilestone` logs and, for each new raise, calls:

1. `VaultraAdapter.registerCase(escrowId, milestoneIndex, noMilestone)`
2. `Aegis.openDispute(adapter, caseId)` — emits `CaseRequested` and
   requests randomness from VRF
3. (When the VRF coordinator calls back) `CaseOpened` is emitted with
   the seated panel; the keeper indexes it into the DB

The keeper is permissionless — anyone can run one. The adapter only
accepts registrations for escrows where `arbiter == adapter`, so
bogus registrations cannot poison Aegis.

The same keeper also sweeps stalled cases (auto-finalize), mirrors
all Aegis events into the DB, logs failed imports for ops debugging,
and handles the appeal-stage status transitions.

Run on a cron (every minute is plenty):

```bash
KEEPER_PRIVATE_KEY=0x... \
KEEPER_CHAIN_ID=84532 \
KEEPER_RPC_URL=https://sepolia.base.org \
pnpm keeper
```

## End-to-end smoke test

1. Open a Vaultra escrow with `_arbiter = address(0)` so it picks
   up the adapter as arbiter.
2. Worker raises a dispute on Vaultra (`raiseDispute` or
   `raiseDisputeNoMilestone`).
3. Keeper picks up the event and calls
   `adapter.registerCase` + `aegis.openDispute`. Status: `awaiting_panel`.
4. Chainlink VRF fulfils. Status flips to `open`. The new case appears
   in `app/cases` with the seated panel.
5. Each panel member signs into the Aegis app, posts a brief
   (optionally encrypted), then commits and reveals a vote.
6. Once the reveal window closes, anyone calls `Aegis.finalize(caseId)`
   — the court computes the median, stages it, and status flips to
   `appealable_resolved`.
7. Either party can call `requestAppeal` within the appeal window
   (default 7 days) by posting an ELCP bond. If no appeal:
8. After the appeal window expires, anyone calls `Aegis.finalize`
   again. The court calls `VaultraAdapter.applyArbitration(...)`,
   which calls `Vaultra.resolveDispute*` with the panel's verdict.
   Vaultra pays the 2.5%–5% arbiter cut to the adapter, which
   forwards it to Aegis, which credits 80% to revealing panelists
   and 20% to the treasury.

If an appeal is filed, see `docs/security-review.md` (F-07) and the
`README.md` "Appeals" section for the upheld / overturned paths.

## What changes in Vaultra

Nothing at the contract level. Vaultra's existing
`updateEclipseDAO(address)` is the only seam needed; Aegis is just
an address the adapter is registered at on Vaultra's behalf.

The only Vaultra-side **product** change is messaging: the existing
`/arbitration` UI inside Vaultra becomes legacy once new escrows
route through Aegis. Updating Vaultra's docs to point users at Aegis
for post-funding disputes is a separate PR on Vaultra and is not
required for the integration to work.

## Operational dependencies

After deploy, monitor:

- **Chainlink VRF subscription LINK balance.** Out-of-LINK ⇒
  `openDispute` reverts, no new cases can open. The `/admin` page
  shows a "VRF stuck" count for cases stuck in `awaiting_panel`
  > 1 hour.
- **Keeper liveness.** `/admin` shows cursor lag per indexed event.
  If lag > 30 minutes the badge turns amber, > 1 hour red.
- **Keeper failure log.** Cases the keeper couldn't bridge appear
  on `/admin/failures` with the reason and attempt count. Mark
  manually resolved when handled out-of-band.
- **Auto-finalize gas.** The keeper's `KEEPER_PRIVATE_KEY` pays gas
  for `finalize` on stalled cases. Keep it funded.
