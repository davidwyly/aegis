import { expect } from "chai"
import { ethers } from "hardhat"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import type {
  Aegis,
  VaultraAdapter,
  VaultraEscrow,
  MockUSDC,
  MockERC20,
  MockVRFCoordinator,
} from "../typechain-types"
import type { Signer } from "ethers"

const VRF_KEY_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000001"
const VRF_SUB_ID = 1n
const VRF_CONFIRMATIONS = 3
const VRF_CALLBACK_GAS = 500_000

// VaultraEscrow numeric encodings
const VAULTRA_STATUS_ACTIVE = 0n
const VAULTRA_STATUS_COMPLETED = 1n
const VAULTRA_STATUS_DISPUTED = 2n

const VOTE_WINDOW = 60 * 60 * 24
const REVEAL_WINDOW = 60 * 60 * 24
const GRACE_WINDOW = 60 * 60 * 12
const STAKE_REQ = ethers.parseEther("100")
const PANEL_FEE_BPS = 8000

const usdc = (n: string) => ethers.parseUnits(n, 6)

// Mirror Vaultra's fee math (lines 14-27 of VaultraEscrow.sol)
const VAULTRA_FEE_BPS = 25n
const VAULTRA_FEE_DENOM = 1000n
const platformFee = (amount: bigint) => (amount * VAULTRA_FEE_BPS) / VAULTRA_FEE_DENOM
const disputeCollateral = (amount: bigint) => (amount * VAULTRA_FEE_BPS) / VAULTRA_FEE_DENOM
const totalUpfront = (amount: bigint) => amount + platformFee(amount) + disputeCollateral(amount)

const PROPOSAL_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("integration-proposal"))

async function fixture() {
  const signers = await ethers.getSigners()
  const [governance, treasury, vaultraOwner, client, worker, ...rest] = signers
  const arbiterSigners = rest.slice(0, 6)

  // ── Tokens ────────────────────────────────────────────────────────
  const USDC = await ethers.getContractFactory("MockUSDC")
  const usdcToken = (await USDC.deploy()) as unknown as MockUSDC
  await usdcToken.waitForDeployment()

  const ELCP = await ethers.getContractFactory("MockERC20")
  const elcpToken = (await ELCP.deploy("Eclipse", "ELCP", 18)) as unknown as MockERC20
  await elcpToken.waitForDeployment()

  // ── VRF coordinator (mock) ───────────────────────────────────────
  const Coord = await ethers.getContractFactory("MockVRFCoordinator")
  const coordinator = (await Coord.deploy()) as unknown as MockVRFCoordinator
  await coordinator.waitForDeployment()

  // ── Aegis ─────────────────────────────────────────────────────────
  const Aegis = await ethers.getContractFactory("Aegis")
  const aegis = (await Aegis.deploy(
    governance.address,
    await elcpToken.getAddress(),
    await coordinator.getAddress(),
    {
      keyHash: VRF_KEY_HASH,
      subscriptionId: VRF_SUB_ID,
      requestConfirmations: VRF_CONFIRMATIONS,
      callbackGasLimit: VRF_CALLBACK_GAS,
    },
    {
      panelSize: 3,
      voteWindow: VOTE_WINDOW,
      revealWindow: REVEAL_WINDOW,
      graceWindow: GRACE_WINDOW,
      stakeRequirement: STAKE_REQ,
      panelFeeBps: PANEL_FEE_BPS,
      treasury: treasury.address,
    }
  )) as unknown as Aegis
  await aegis.waitForDeployment()

  // ── Vaultra ──────────────────────────────────────────────────────
  // We deploy Vaultra with a placeholder eclipseDAO, then update it to the
  // adapter once the adapter exists. (Adapter needs vaultra's address at
  // construction.)
  const Vaultra = await ethers.getContractFactory("VaultraEscrow")
  const placeholderDAO = vaultraOwner.address // safe placeholder, not arbiter for any real escrow
  const vaultra = (await Vaultra.deploy(
    await usdcToken.getAddress(),
    placeholderDAO,
    vaultraOwner.address
  )) as unknown as VaultraEscrow
  await vaultra.waitForDeployment()

  // ── Adapter ──────────────────────────────────────────────────────
  const Adapter = await ethers.getContractFactory("VaultraAdapter")
  const adapter = (await Adapter.deploy(
    await aegis.getAddress(),
    await vaultra.getAddress()
  )) as unknown as VaultraAdapter
  await adapter.waitForDeployment()

  // Wire Vaultra's eclipseDAO to the adapter (Ownable2Step → set then
  // any address is fine since we only need eclipseDAO updated, not ownership).
  await vaultra.connect(vaultraOwner).updateEclipseDAO(await adapter.getAddress())

  // ── Roster: register + stake 6 arbiters so we have plenty for redraws ──
  for (const a of arbiterSigners) {
    await elcpToken.mint(a.address, ethers.parseEther("10000"))
    await elcpToken.connect(a).approve(await aegis.getAddress(), ethers.MaxUint256)
    await aegis.connect(governance).registerArbiter(a.address, ethers.ZeroHash)
    await aegis.connect(a).stake(STAKE_REQ)
  }

  // Fund the client.
  await usdcToken.mint(client.address, usdc("1000000"))

  return {
    aegis,
    coordinator,
    adapter,
    vaultra,
    usdcToken,
    elcpToken,
    governance,
    treasury,
    vaultraOwner,
    client,
    worker,
    arbiterSigners,
  }
}

async function createAndFundEscrow(
  vaultra: VaultraEscrow,
  usdcToken: MockUSDC,
  client: Signer,
  worker: Signer,
  amount: bigint
): Promise<string> {
  const clientAddr = await client.getAddress()
  const workerAddr = await worker.getAddress()
  await usdcToken.connect(client).approve(await vaultra.getAddress(), totalUpfront(amount))
  const tx = await vaultra
    .connect(client)
    .createEscrow(
      "integration",
      "round-trip test",
      workerAddr,
      ethers.ZeroAddress, // arbiter = adapter via eclipseDAO default
      amount,
      PROPOSAL_DIGEST
    )
  const receipt = await tx.wait()
  const log = receipt!.logs
    .map((l) => {
      try {
        return vaultra.interface.parseLog(l)
      } catch {
        return null
      }
    })
    .find((e) => e?.name === "EscrowCreated")
  void clientAddr
  return log!.args.escrowId as string
}

describe("Aegis ↔ VaultraEscrow integration", () => {
  it("real Vaultra dispute → Aegis panel verdict → on-chain settlement", async () => {
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

    // ── Create + fund a non-milestone escrow on Vaultra ────────────
    const amount = usdc("1000")
    const escrowId = await createAndFundEscrow(vaultra, usdcToken, client, worker, amount)

    // Sanity: the adapter is the assigned arbiter on the escrow.
    const e = await vaultra.getEscrow(escrowId)
    expect(e.arbiter).to.equal(await adapter.getAddress())
    expect(e.status).to.equal(VAULTRA_STATUS_ACTIVE)

    // ── Worker raises a dispute on Vaultra ───────────────────────────
    await vaultra.connect(worker).raiseDisputeNoMilestone(escrowId)
    const eDisp = await vaultra.getEscrow(escrowId)
    expect(eDisp.status).to.equal(VAULTRA_STATUS_DISPUTED)

    // ── Adapter registers the case + Aegis opens it ─────────────────
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

    // Drive the VRF fulfillment so the panel is seated.
    const fulfillTx = await ctx.coordinator.fulfillWithSingleWord(requestId, 0xdeadbeefcafebaben)
    const fulfillReceipt = await fulfillTx.wait()
    const openedLog = fulfillReceipt!.logs
      .map((l) => {
        try {
          return aegis.interface.parseLog(l as any)
        } catch {
          return null
        }
      })
      .find((e) => e?.name === "CaseOpened")
    expect(openedLog).to.exist
    const panel = (openedLog!.args.panel as string[]).map((a) => a.toLowerCase())
    const panelSigners = arbiterSigners.filter((s) =>
      panel.includes(s.address.toLowerCase())
    )
    expect(panelSigners.length).to.equal(3)
    // No party can be a panelist.
    expect(panel).to.not.include((await client.getAddress()).toLowerCase())
    expect(panel).to.not.include((await worker.getAddress()).toLowerCase())

    // Sanity: Aegis read the right context out of the adapter.
    const aegisCase = await aegis.getCase(aegisCaseId)
    expect(aegisCase.partyA.toLowerCase()).to.equal(
      (await client.getAddress()).toLowerCase()
    )
    expect(aegisCase.partyB.toLowerCase()).to.equal(
      (await worker.getAddress()).toLowerCase()
    )
    expect(aegisCase.feeToken.toLowerCase()).to.equal(
      (await usdcToken.getAddress()).toLowerCase()
    )
    expect(aegisCase.amount).to.equal(amount)

    // ── Panel commit + reveal ────────────────────────────────────────
    const votes = [
      { pct: 30, salt: ethers.id("salt-A"), digest: ethers.id("digest-A") },
      { pct: 50, salt: ethers.id("salt-B"), digest: ethers.id("digest-B") },
      { pct: 70, salt: ethers.id("salt-C"), digest: ethers.id("digest-C") },
    ]
    for (let i = 0; i < panelSigners.length; i++) {
      const v = votes[i]
      const h = await aegis.hashVote(panelSigners[i].address, aegisCaseId, v.pct, v.salt, v.digest)
      await aegis.connect(panelSigners[i]).commitVote(aegisCaseId, h)
    }
    await time.increase(VOTE_WINDOW + 1)
    for (let i = 0; i < panelSigners.length; i++) {
      const v = votes[i]
      await aegis.connect(panelSigners[i]).revealVote(aegisCaseId, v.pct, v.salt, v.digest)
    }

    // ── Snapshot balances then finalize ─────────────────────────────
    const usdcAddr = await usdcToken.getAddress()
    const clientUsdcBefore = await usdcToken.balanceOf(client.getAddress())
    const workerUsdcBefore = await usdcToken.balanceOf(worker.getAddress())

    await aegis.finalize(aegisCaseId)

    // ── Assertions: Vaultra escrow resolved at the median (50%) ─────
    const eAfter = await vaultra.getEscrow(escrowId)
    expect(eAfter.status).to.equal(VAULTRA_STATUS_COMPLETED)

    // median(30,50,70) = 50 → 500 USDC each (before worker dispute fee deduction)
    // Worker dispute fee deducts 2.5% of total = 25 USDC from worker payout.
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

    // ── Aegis received the arbiter cut ──────────────────────────────
    // Vaultra paid: client collateral (25) + worker cut (25) = 50 USDC to the
    // adapter, which forwarded it to Aegis at applyArbitration time.
    const expectedFee = disputeCollateral(amount) + workerDisputeCut // 50
    // 80% to revealing panelists, 20% to treasury. 3 panelists each got 40/3 = 13 dust 1.
    const panelTotal = (expectedFee * BigInt(PANEL_FEE_BPS)) / 10_000n // 40
    const each = panelTotal / 3n // 13
    const distributed = each * 3n // 39
    const treasuryAmount = expectedFee - panelTotal + (panelTotal - distributed)

    for (const p of panelSigners) {
      expect(await aegis.claimable(p.address, usdcAddr)).to.equal(each)
    }
    expect(await aegis.treasuryAccrued(usdcAddr)).to.equal(treasuryAmount)

    // ── A panelist can claim their fee ─────────────────────────────
    const me = panelSigners[0]
    const before = await usdcToken.balanceOf(me.address)
    await aegis.connect(me).claim(usdcAddr)
    expect(await usdcToken.balanceOf(me.address)).to.equal(before + each)
    expect(await aegis.claimable(me.address, usdcAddr)).to.equal(0)

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
})
