import { expect } from "chai"
import { ethers, network } from "hardhat"
import { time } from "@nomicfoundation/hardhat-network-helpers"
import {
  APPEAL_WINDOW,
  PER_ARBITER_FEE_BPS,
  VAULTRA_FEE_BPS,
  VAULTRA_FEE_DENOM,
  VAULTRA_STATUS_COMPLETED,
  VAULTRA_STATUS_DISPUTED,
  VOTE_WINDOW,
  createAndFundEscrow,
  deployIntegrationStack,
  disputeCollateral,
  usdc,
} from "./helpers/integrationFixture"

/**
 * Hardhat-fork integration test against Base Sepolia.
 *
 * Verifies the same Aegis verdict → Vaultra resolution chain that the
 * local-network test covers, but runs on a `hardhat_reset` snapshot of
 * Base Sepolia so chain id (84532), block timestamps, and EVM context
 * match production. When Vaultra deploys to Base Sepolia, the fixture
 * is the single seam where the deployed address gets swapped in (today
 * the fork test deploys Vaultra fresh on the fork).
 *
 * Skipped unless `BASE_SEPOLIA_FORK_URL` is set, since CI without an
 * archive RPC has no way to hardhat_reset to a fork. To run locally:
 *
 *   BASE_SEPOLIA_FORK_URL=https://sepolia.base.org \
 *     pnpm contracts:test test/AegisVaultraForkIntegration.test.ts
 *
 * `https://sepolia.base.org` is rate-limited but works for one-off
 * runs; an Alchemy / Infura archive endpoint is faster and CI-grade.
 */

const FORK_URL = process.env.BASE_SEPOLIA_FORK_URL
const BASE_SEPOLIA_CHAIN_ID = 84532

const describeFork = FORK_URL ? describe : describe.skip

describeFork("Aegis ↔ VaultraEscrow on Base Sepolia fork", () => {
  before(async function () {
    this.timeout(120_000)
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: FORK_URL!,
          },
        },
      ],
    })
  })

  after(async () => {
    // Reset back to a clean local network so subsequent test files in
    // the same `hardhat test` invocation don't inherit fork state.
    await network.provider.request({
      method: "hardhat_reset",
      params: [],
    })
  })

  it("hardhat_metadata reports the source fork is Base Sepolia", async () => {
    // The local hardhat network keeps chainId 31337 even when forking;
    // the source chain is exposed via the hardhat_metadata RPC.
    const meta = (await network.provider.send("hardhat_metadata", [])) as {
      forkedNetwork?: { chainId: number }
    }
    expect(meta.forkedNetwork?.chainId).to.equal(BASE_SEPOLIA_CHAIN_ID)
  })

  it("real Vaultra dispute → Aegis single-arbiter verdict → on-chain settlement", async function () {
    this.timeout(180_000)

    const ctx = await deployIntegrationStack()
    const {
      aegis,
      adapter,
      vaultra,
      usdcToken,
      client,
      worker,
      arbiterSigners,
      coordinator,
    } = ctx

    const amount = usdc("1000")
    const escrowId = await createAndFundEscrow(
      vaultra,
      usdcToken,
      client,
      worker,
      amount,
    )
    expect((await vaultra.getEscrow(escrowId)).arbiter).to.equal(
      await adapter.getAddress(),
    )

    await vaultra.connect(worker).raiseDisputeNoMilestone(escrowId)
    expect((await vaultra.getEscrow(escrowId)).status).to.equal(
      VAULTRA_STATUS_DISPUTED,
    )

    const expectedCaseId = await adapter.packCaseId(escrowId, 0n, true)
    await adapter.connect(client).registerCase(escrowId, 0n, true)

    const openTx = await aegis.openDispute(
      await adapter.getAddress(),
      expectedCaseId,
    )
    const openReceipt = await openTx.wait()
    const requested = openReceipt!.logs
      .map((l) => {
        try {
          return aegis.interface.parseLog(l as never)
        } catch {
          return null
        }
      })
      .find((parsed) => parsed?.name === "CaseRequested")
    const aegisCaseId = requested!.args.caseId as string
    const requestId = requested!.args.vrfRequestId as bigint

    // VRF fulfillment seats a single original arbiter.
    const fulfillTx = await coordinator.fulfillWithSingleWord(
      requestId,
      0xdeadbeefcafebaben,
    )
    const fulfillReceipt = await fulfillTx.wait()
    const drawnLog = fulfillReceipt!.logs
      .map((l) => {
        try {
          return aegis.interface.parseLog(l as never)
        } catch {
          return null
        }
      })
      .find((parsed) => parsed?.name === "ArbiterDrawn")
    expect(drawnLog).to.exist
    const arbiterAddr = (drawnLog!.args.arbiter as string).toLowerCase()
    const arbiterSigner = arbiterSigners.find(
      async (s) => (await s.getAddress()).toLowerCase() === arbiterAddr,
    )
    // Re-derive synchronously since `find` resolves the promise out of
    // band on async predicates.
    let resolvedArbiter = arbiterSigner
    for (const s of arbiterSigners) {
      if ((await s.getAddress()).toLowerCase() === arbiterAddr) {
        resolvedArbiter = s
        break
      }
    }
    expect(resolvedArbiter, "drawn arbiter not in roster").to.exist

    // Single-arbiter commit + reveal.
    const pct = 50
    const salt = ethers.id("salt-fork")
    const digest = ethers.id("digest-fork")
    const arbiterSignerAddr = await resolvedArbiter!.getAddress()
    const h = await aegis.hashVote(
      arbiterSignerAddr,
      aegisCaseId,
      pct,
      salt,
      digest,
    )
    await aegis.connect(resolvedArbiter!).commitVote(aegisCaseId, h)
    await time.increase(VOTE_WINDOW + 1)
    await aegis
      .connect(resolvedArbiter!)
      .revealVote(aegisCaseId, pct, salt, digest)
    expect((await aegis.getCase(aegisCaseId)).state).to.equal(
      3 /* AppealableResolved */,
    )

    const usdcAddr = await usdcToken.getAddress()
    const clientUsdcBefore = await usdcToken.balanceOf(client.getAddress())
    const workerUsdcBefore = await usdcToken.balanceOf(worker.getAddress())

    // No appeal: advance past the appeal window and finalize.
    await time.increase(APPEAL_WINDOW + 1)
    await aegis.finalize(aegisCaseId)

    expect((await vaultra.getEscrow(escrowId)).status).to.equal(
      VAULTRA_STATUS_COMPLETED,
    )

    const clientShare = (amount * BigInt(pct)) / 100n
    const workerShareBeforeFee = amount - clientShare
    const workerDisputeCut = (amount * VAULTRA_FEE_BPS) / VAULTRA_FEE_DENOM
    const workerShare = workerShareBeforeFee - workerDisputeCut
    expect(await usdcToken.balanceOf(client.getAddress())).to.equal(
      clientUsdcBefore + clientShare,
    )
    expect(await usdcToken.balanceOf(worker.getAddress())).to.equal(
      workerUsdcBefore + workerShare,
    )

    // D1(c) split: half (perArbiterFeeBps=2.5% of amount) to arbiter,
    // half rebated by verdict pct to the parties.
    const expectedFee = disputeCollateral(amount) + workerDisputeCut
    const arbiterShare =
      (amount * BigInt(PER_ARBITER_FEE_BPS)) / 10_000n
    const rebatePool = expectedFee - arbiterShare
    const partyARebate = (rebatePool * BigInt(pct)) / 100n
    const partyBRebate = rebatePool - partyARebate
    expect(
      await aegis.claimable(arbiterSignerAddr, usdcAddr),
    ).to.equal(arbiterShare)
    expect(
      await aegis.claimable(client.getAddress(), usdcAddr),
    ).to.equal(partyARebate)
    expect(
      await aegis.claimable(worker.getAddress(), usdcAddr),
    ).to.equal(partyBRebate)
    expect(await aegis.treasuryAccrued(usdcAddr)).to.equal(0)
  })
})
