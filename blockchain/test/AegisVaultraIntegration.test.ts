import { expect } from "chai"
import { ethers } from "hardhat"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import {
  VAULTRA_FEE_BPS,
  VAULTRA_FEE_DENOM,
  VAULTRA_STATUS_COMPLETED,
  VAULTRA_STATUS_DISPUTED,
  VOTE_WINDOW,
  createAndFundEscrow,
  createAndFundMilestoneEscrow,
  deployIntegrationStack,
  disputeCollateral,
  usdc,
} from "./helpers/integrationFixture"

const fixture = deployIntegrationStack

describe("Aegis ↔ VaultraEscrow integration", () => {
  it("real Vaultra dispute → Aegis single-arbiter verdict → on-chain settlement", async () => {
    const ctx = await loadFixture(fixture)
    const {
      aegis,
      adapter,
      vaultra,
      usdcToken,
      treasury,
      client,
      worker,
      arbiterSigners,
    } = ctx

    // Create + fund a non-milestone escrow on Vaultra.
    const amount = usdc("1000")
    const escrowId = await createAndFundEscrow(vaultra, usdcToken, client, worker, amount)
    expect((await vaultra.getEscrow(escrowId)).arbiter).to.equal(await adapter.getAddress())

    // Worker raises a dispute on Vaultra.
    await vaultra.connect(worker).raiseDisputeNoMilestone(escrowId)
    expect((await vaultra.getEscrow(escrowId)).status).to.equal(VAULTRA_STATUS_DISPUTED)

    // Adapter registers the case; Aegis opens it.
    const expectedCaseId = await adapter.packCaseId(escrowId, 0n, true)
    await adapter.connect(client).registerCase(escrowId, 0n, true)

    const openTx = await aegis.openDispute(await adapter.getAddress(), expectedCaseId)
    const openReceipt = await openTx.wait()
    const requested = openReceipt!.logs
      .map((l) => {
        try {
          return aegis.interface.parseLog(l as any)
        } catch {
          return null
        }
      })
      .find((e) => e?.name === "CaseRequested")
    const aegisCaseId = requested!.args.caseId as string
    const requestId = requested!.args.vrfRequestId as bigint

    // VRF fulfillment seats a single original arbiter.
    const fulfillTx = await ctx.coordinator.fulfillWithSingleWord(requestId, 0xdeadbeefcafebaben)
    const fulfillReceipt = await fulfillTx.wait()
    const drawnLog = fulfillReceipt!.logs
      .map((l) => {
        try {
          return aegis.interface.parseLog(l as any)
        } catch {
          return null
        }
      })
      .find((e) => e?.name === "ArbiterDrawn")
    expect(drawnLog).to.exist
    const arbiterAddr = (drawnLog!.args.arbiter as string).toLowerCase()
    const arbiterSigner = arbiterSigners.find(
      (s) => s.address.toLowerCase() === arbiterAddr
    )!
    // Sanity: drawn arbiter is not a party.
    expect(arbiterAddr).to.not.equal((await client.getAddress()).toLowerCase())
    expect(arbiterAddr).to.not.equal((await worker.getAddress()).toLowerCase())

    // Aegis read the right context out of the adapter.
    const aegisCase = await aegis.getCase(aegisCaseId)
    expect(aegisCase.partyA.toLowerCase()).to.equal(
      (await client.getAddress()).toLowerCase()
    )
    expect(aegisCase.partyB.toLowerCase()).to.equal(
      (await worker.getAddress()).toLowerCase()
    )
    expect(aegisCase.amount).to.equal(amount)

    // Single-arbiter commit + reveal.
    const pct = 50
    const salt = ethers.id("salt")
    const digest = ethers.id("digest")
    const h = await aegis.hashVote(arbiterSigner.address, aegisCaseId, pct, salt, digest)
    await aegis.connect(arbiterSigner).commitVote(aegisCaseId, h)
    await time.increase(VOTE_WINDOW + 1)
    await aegis.connect(arbiterSigner).revealVote(aegisCaseId, pct, salt, digest)
    expect((await aegis.getCase(aegisCaseId)).state).to.equal(3 /* AppealableResolved */)

    // Snapshot balances before finalize.
    const usdcAddr = await usdcToken.getAddress()
    const clientUsdcBefore = await usdcToken.balanceOf(client.getAddress())
    const workerUsdcBefore = await usdcToken.balanceOf(worker.getAddress())

    // No appeal: advance past the 7-day appeal window and finalize.
    await time.increase(60 * 60 * 24 * 7 + 1)
    await aegis.finalize(aegisCaseId)

    // Vaultra escrow settles at 50/50.
    expect((await vaultra.getEscrow(escrowId)).status).to.equal(VAULTRA_STATUS_COMPLETED)

    // 50/50 verdict: client gets half (no fee deducted from client side
    // since that came from the held collateral). Worker gets half minus
    // the 2.5% Vaultra dispute cut.
    const clientShare = (amount * 50n) / 100n // 500
    const workerShareBeforeFee = amount - clientShare // 500
    const workerDisputeCut = (amount * VAULTRA_FEE_BPS) / VAULTRA_FEE_DENOM // 25
    const workerShare = workerShareBeforeFee - workerDisputeCut // 475
    expect(await usdcToken.balanceOf(client.getAddress())).to.equal(
      clientUsdcBefore + clientShare
    )
    expect(await usdcToken.balanceOf(worker.getAddress())).to.equal(
      workerUsdcBefore + workerShare
    )

    // Aegis received the arbiter cut: client collateral (25) + worker cut (25) = 50 USDC.
    const expectedFee = disputeCollateral(amount) + workerDisputeCut // 50
    // D1(c) split: half (2.5% of amount = 25) to arbiter, half (25) rebated 50/50 by verdict.
    const arbiterShare = expectedFee / 2n // 25
    const rebatePool = expectedFee - arbiterShare // 25
    const partyARebate = (rebatePool * BigInt(pct)) / 100n // 12 (with floor)
    const partyBRebate = rebatePool - partyARebate // 13
    expect(await aegis.claimable(arbiterSigner.address, usdcAddr)).to.equal(arbiterShare)
    expect(await aegis.claimable(client.getAddress(), usdcAddr)).to.equal(partyARebate)
    expect(await aegis.claimable(worker.getAddress(), usdcAddr)).to.equal(partyBRebate)
    // Treasury gets nothing on the no-appeal path under D4.
    expect(await aegis.treasuryAccrued(usdcAddr)).to.equal(0)

    // Arbiter can claim their fee.
    const before = await usdcToken.balanceOf(arbiterSigner.address)
    await aegis.connect(arbiterSigner).claim(usdcAddr)
    expect(await usdcToken.balanceOf(arbiterSigner.address)).to.equal(before + arbiterShare)
    expect(await aegis.claimable(arbiterSigner.address, usdcAddr)).to.equal(0)

    void treasury
  })

  it("registerCase rejects an escrow whose arbiter is not the adapter", async () => {
    const ctx = await loadFixture(fixture)
    const { adapter, vaultra, usdcToken, vaultraOwner, treasury, client, worker } = ctx

    // Reset eclipseDAO to an address that's neither party nor adapter — so
    // newly-created escrows pick this up as arbiter and the adapter has no
    // standing on them.
    await vaultra.connect(vaultraOwner).updateEclipseDAO(treasury.address)

    const amount = usdc("100")
    const escrowId = await createAndFundEscrow(vaultra, usdcToken, client, worker, amount)
    await vaultra.connect(worker).raiseDisputeNoMilestone(escrowId)

    await expect(
      adapter.connect(client).registerCase(escrowId, 0n, true)
    ).to.be.revertedWithCustomError(adapter, "NotArbiter")
  })

  it("registerCase rejects an escrow that is not Disputed", async () => {
    const ctx = await loadFixture(fixture)
    const { adapter, vaultra, usdcToken, client, worker } = ctx

    const amount = usdc("100")
    const escrowId = await createAndFundEscrow(vaultra, usdcToken, client, worker, amount)
    // No dispute raised — escrow is Active.
    await expect(
      adapter.connect(client).registerCase(escrowId, 0n, true)
    ).to.be.revertedWithCustomError(adapter, "NotDisputed")
  })

  it("registerCase rejects a non-disputed milestone on a disputed escrow", async () => {
    const ctx = await loadFixture(fixture)
    const { adapter, vaultra, usdcToken, client, worker } = ctx

    // Two-milestone escrow; dispute only milestone 0.
    const escrowId = await createAndFundMilestoneEscrow(
      vaultra,
      usdcToken,
      client,
      worker,
      [usdc("60"), usdc("40")],
    )
    await vaultra.connect(worker).raiseDispute(escrowId, 0n)
    expect((await vaultra.getEscrow(escrowId)).status).to.equal(VAULTRA_STATUS_DISPUTED)

    // Registering milestone 0 succeeds (it really is disputed).
    await adapter.connect(client).registerCase(escrowId, 0n, false)

    // Registering milestone 1 would otherwise burn a VRF request and
    // stick the case at finalize — the new check refuses it up front.
    await expect(
      adapter.connect(client).registerCase(escrowId, 1n, false)
    ).to.be.revertedWithCustomError(adapter, "MilestoneNotDisputed")
  })

  it("registerCase rejects an out-of-range milestone index", async () => {
    const ctx = await loadFixture(fixture)
    const { adapter, vaultra, usdcToken, client, worker } = ctx

    const escrowId = await createAndFundMilestoneEscrow(
      vaultra,
      usdcToken,
      client,
      worker,
      [usdc("100")],
    )
    await vaultra.connect(worker).raiseDispute(escrowId, 0n)

    await expect(
      adapter.connect(client).registerCase(escrowId, 5n, false)
    ).to.be.revertedWithCustomError(adapter, "InvalidMilestoneIndex")
  })

  it("registerCase rejects noMilestone=true on a milestone escrow", async () => {
    const ctx = await loadFixture(fixture)
    const { adapter, vaultra, usdcToken, client, worker } = ctx

    const escrowId = await createAndFundMilestoneEscrow(
      vaultra,
      usdcToken,
      client,
      worker,
      [usdc("100")],
    )
    await vaultra.connect(worker).raiseDispute(escrowId, 0n)

    await expect(
      adapter.connect(client).registerCase(escrowId, 0n, true)
    ).to.be.revertedWithCustomError(adapter, "MilestoneShapeMismatch")
  })

  it("registerCase rejects noMilestone=false on a lump-sum escrow", async () => {
    const ctx = await loadFixture(fixture)
    const { adapter, vaultra, usdcToken, client, worker } = ctx

    const escrowId = await createAndFundEscrow(vaultra, usdcToken, client, worker, usdc("100"))
    await vaultra.connect(worker).raiseDisputeNoMilestone(escrowId)

    await expect(
      adapter.connect(client).registerCase(escrowId, 0n, false)
    ).to.be.revertedWithCustomError(adapter, "MilestoneShapeMismatch")
  })

  it("registerCase rejects non-zero milestoneIndex on noMilestone=true", async () => {
    const ctx = await loadFixture(fixture)
    const { adapter, vaultra, usdcToken, client, worker } = ctx

    const escrowId = await createAndFundEscrow(vaultra, usdcToken, client, worker, usdc("100"))
    await vaultra.connect(worker).raiseDisputeNoMilestone(escrowId)

    // Without this guard, anyone could spawn parallel Aegis cases by
    // varying milestoneIndex (it hashes into the caseId but is ignored
    // by resolveDisputeNoMilestone). Only milestoneIndex == 0 is the
    // canonical form on the no-milestone path.
    await expect(
      adapter.connect(client).registerCase(escrowId, 1n, true)
    ).to.be.revertedWithCustomError(adapter, "InvalidMilestoneIndex")

    // The canonical form still succeeds.
    await adapter.connect(client).registerCase(escrowId, 0n, true)
  })
})
