# Plugging Vaultra into Aegis

This is the one-pager. The Aegis-side rationale lives in the design plan;
this doc is just the pragmatic checklist.

## What you need before you start

- A deployed **Eclipse DAO `Governance.sol`** address on the target chain.
  Aegis grants this address `DEFAULT_ADMIN_ROLE` + `GOVERNANCE_ROLE` at
  construction. All registry / policy changes flow through DAO proposals.
- A deployed **ELCP token** on the target chain. Stake is denominated in
  this token; arbiters bond it via `Aegis.stake(amount)`.
- A deployed **VaultraEscrow** instance whose owner you control (you'll
  point its `eclipseDAO` slot at the adapter you're about to deploy).

## Deploy order

```bash
# 1. Aegis
pnpm -C blockchain hardhat ignition deploy ignition/modules/Aegis.ts \
  --network baseSepolia \
  --parameters '{
    "Aegis": {
      "governance": "0x<eclipse-governance>",
      "stakeToken": "0x<elcp-token>",
      "treasury":   "0x<eclipse-treasury>"
    }
  }'

# 2. VaultraAdapter (pointing at the Aegis you just deployed)
pnpm -C blockchain hardhat ignition deploy ignition/modules/VaultraAdapter.ts \
  --network baseSepolia \
  --parameters '{
    "VaultraAdapter": {
      "aegis":   "0x<aegis>",
      "vaultra": "0x<vaultra>"
    }
  }'

# 3. Wire Vaultra to point new escrows' default arbiter at the adapter.
#    (Vaultra owner only; not the deployer of this repo.)
cast send <vaultra> "updateEclipseDAO(address)" <adapter>
```

Existing Vaultra escrows keep their original arbiter. Only freshly-created
ones default to the adapter.

## Onboard arbiters

Submit Eclipse DAO proposals targeting `Aegis.registerArbiter(addr, ipfsCID)`.
The `app/governance` page generates the calldata.

Each registered arbiter then self-stakes ELCP:

```ts
await elcp.approve(aegisAddress, stakeRequirement)
await aegis.stake(stakeRequirement)
```

Arbiters whose `stakedAmount` falls below `policy.stakeRequirement` are
skipped on future panel draws but stay on already-assigned panels.

## What the keeper does

`scripts/keeper.ts` polls Vaultra's `DisputeRaised` /
`DisputeRaisedNoMilestone` logs and, for each new raise, calls:

1. `VaultraAdapter.registerCase(escrowId, milestoneIndex, noMilestone)`
2. `Aegis.openDispute(adapter, caseId)`

The keeper is permissionless — anyone can run one. The adapter only
accepts registrations for escrows where `arbiter == adapter`, so bogus
registrations cannot poison Aegis.

Run on a cron (every minute is plenty):

```bash
KEEPER_PRIVATE_KEY=0x... \
KEEPER_CHAIN_ID=84532 \
KEEPER_RPC_URL=https://sepolia.base.org \
pnpm keeper
```

## End-to-end smoke test

1. Open a Vaultra escrow with `_arbiter = address(0)` so it picks up the
   adapter as arbiter.
2. Worker raises a dispute on Vaultra (`raiseDispute` or
   `raiseDisputeNoMilestone`).
3. Keeper picks up the event and opens a case on Aegis. The new case
   appears in `app/cases`.
4. Each panel member signs into the Aegis app, posts a brief, then
   commits and reveals a vote.
5. Once the reveal window closes, anyone calls `Aegis.finalize(caseId)` —
   the court computes the median, calls
   `VaultraAdapter.applyArbitration(...)`, which calls
   `Vaultra.resolveDispute*` with the panel's verdict. Vaultra pays the
   2.5%–5% arbiter cut to the adapter, which forwards it to Aegis, which
   credits 80% to revealing panelists and 20% to the treasury.

## What changes in Vaultra

Nothing at the contract level. Vaultra's existing
`updateEclipseDAO(address)` is the only seam needed; Aegis is just an
address the adapter is registered at on Vaultra's behalf.

The only Vaultra-side **product** change is messaging: the existing
`/arbitration` UI inside Vaultra becomes legacy once new escrows route
through Aegis. Updating Vaultra's docs to point users at Aegis for
post-funding disputes is a separate PR on Vaultra and is not required
for the integration to work.
