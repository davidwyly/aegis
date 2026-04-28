import { expect } from "chai"
import { ethers, network } from "hardhat"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import type {
  Aegis,
  MockArbitrableEscrow,
  MockERC20,
  MockVRFCoordinator,
} from "../typechain-types"
import type { Signer, ContractTransactionResponse } from "ethers"

const VRF_KEY_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000001"
const VRF_SUB_ID = 1n
const VRF_CONFIRMATIONS = 3
const VRF_CALLBACK_GAS = 500_000

const elcp = (n: string) => ethers.parseEther(n)
const usdc = (n: string) => ethers.parseUnits(n, 6)

const VOTE_WINDOW = 60 * 60 * 24 // 1 day
const REVEAL_WINDOW = 60 * 60 * 24 // 1 day
const GRACE_WINDOW = 60 * 60 * 12 // 12 h
const STAKE_REQ = elcp("100")
const PANEL_FEE_BPS = 8000 // 80% to panel, 20% to treasury

const CASE_NONE = 0
const CASE_AWAITING_PANEL = 1
const CASE_OPEN = 2
const CASE_REVEALING = 3
const CASE_RESOLVED = 4
const CASE_DEFAULT_RESOLVED = 5

async function deployFixture() {
  const signers = await ethers.getSigners()
  const [governance, treasury, partyA, partyB, ...rest] = signers
  // Take 6 candidate arbiters so we have room for redraws.
  const arbiterSigners = rest.slice(0, 6)
  const stranger = rest[6]

  const ELCP = await ethers.getContractFactory("MockERC20")
  const elcpToken = (await ELCP.deploy("Eclipse", "ELCP", 18)) as unknown as MockERC20
  await elcpToken.waitForDeployment()

  const USDC = await ethers.getContractFactory("MockERC20")
  const usdcToken = (await USDC.deploy("USD Coin", "USDC", 6)) as unknown as MockERC20
  await usdcToken.waitForDeployment()

  const Coord = await ethers.getContractFactory("MockVRFCoordinator")
  const coordinator = (await Coord.deploy()) as unknown as MockVRFCoordinator
  await coordinator.waitForDeployment()

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

  const Mock = await ethers.getContractFactory("MockArbitrableEscrow")
  const mock = (await Mock.deploy(await aegis.getAddress())) as unknown as MockArbitrableEscrow
  await mock.waitForDeployment()

  // Mint ELCP to all arbiter candidates and stranger.
  for (const s of [...arbiterSigners, stranger]) {
    await elcpToken.mint(s.address, elcp("10000"))
    await elcpToken.connect(s).approve(await aegis.getAddress(), ethers.MaxUint256)
  }

  return {
    aegis,
    coordinator,
    mock,
    elcpToken,
    usdcToken,
    governance,
    treasury,
    partyA,
    partyB,
    arbiterSigners,
    stranger,
  }
}

/**
 * Helper for tests that want a fully-opened case: calls openDispute,
 * fishes the VRF requestId out of the CaseRequested event, then drives
 * the mock coordinator's fulfillment so the panel is seated. Returns
 * the Aegis caseId and the seated panel.
 */
async function openAndFulfill(
  aegis: Aegis,
  coordinator: MockVRFCoordinator,
  escrow: string,
  escrowCaseId: string,
  randomWord: bigint = 0xdeadbeef0badcafefeedfacef00dn,
): Promise<{ caseId: string; requestId: bigint; panel: string[] }> {
  const openTx = await aegis.openDispute(escrow, escrowCaseId)
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
  const caseId = requested!.args.caseId as string
  const requestId = requested!.args.vrfRequestId as bigint

  const fulfillTx = await coordinator.fulfillWithSingleWord(requestId, randomWord)
  const fulfillReceipt = await fulfillTx.wait()
  const opened = fulfillReceipt!.logs
    .map((l) => {
      try {
        return aegis.interface.parseLog(l as any)
      } catch {
        return null
      }
    })
    .find((e) => e?.name === "CaseOpened")
  const panel = (opened?.args.panel as string[]) ?? []
  return { caseId, requestId, panel }
}

async function registerAndStake(
  aegis: Aegis,
  governance: Signer,
  arbiters: Signer[],
  stake: bigint = STAKE_REQ
) {
  for (const a of arbiters) {
    const cid = ethers.keccak256(ethers.toUtf8Bytes(await a.getAddress()))
    await aegis.connect(governance).registerArbiter(await a.getAddress(), cid)
    await aegis.connect(a).stake(stake)
  }
}

async function setMockCase(
  mock: MockArbitrableEscrow,
  caseId: string,
  partyA: string,
  partyB: string,
  feeToken: string,
  amount: bigint,
  feeAmount: bigint,
  feeFunder: { connect: any; mint: any },
  funderSigner: Signer
) {
  await mock.setCase(caseId, partyA, partyB, feeToken, amount, feeAmount)
  // Pre-fund the mock with fee.
  await (feeFunder as MockERC20).mint(await mock.getAddress(), feeAmount)
}

const CASE_KEY = ethers.keccak256(ethers.toUtf8Bytes("test-case-1"))

describe("Aegis", () => {
  describe("constructor + policy", () => {
    it("initializes with given policy and grants governance role", async () => {
      const { aegis, governance } = await loadFixture(deployFixture)
      const role = await aegis.GOVERNANCE_ROLE()
      expect(await aegis.hasRole(role, governance.address)).to.equal(true)
      const p = await aegis.policy()
      expect(p.panelSize).to.equal(3)
      expect(p.voteWindow).to.equal(VOTE_WINDOW)
      expect(p.panelFeeBps).to.equal(PANEL_FEE_BPS)
    })

    it("rejects even panel sizes via setPolicy", async () => {
      const { aegis, governance, treasury } = await loadFixture(deployFixture)
      await expect(
        aegis.connect(governance).setPolicy({
          panelSize: 4,
          voteWindow: 1,
          revealWindow: 1,
          graceWindow: 1,
          stakeRequirement: 0,
          panelFeeBps: 0,
          treasury: treasury.address,
        })
      ).to.be.revertedWithCustomError(aegis, "InvalidPolicy")
    })
  })

  describe("arbiter roster", () => {
    it("registers + stakes + lists arbiters", async () => {
      const { aegis, governance, arbiterSigners } = await loadFixture(deployFixture)
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      expect(await aegis.arbiterCount()).to.equal(3)
      const stored = await aegis.arbiters(arbiterSigners[0].address)
      expect(stored.active).to.equal(true)
      expect(stored.stakedAmount).to.equal(STAKE_REQ)
    })

    it("revoking slashes entire stake into treasury", async () => {
      const { aegis, governance, treasury, elcpToken, arbiterSigners } = await loadFixture(deployFixture)
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      const target = arbiterSigners[1]
      await aegis.connect(governance).revokeArbiter(target.address)
      const stored = await aegis.arbiters(target.address)
      expect(stored.active).to.equal(false)
      expect(stored.stakedAmount).to.equal(0)
      expect(await aegis.treasuryAccrued(await elcpToken.getAddress())).to.equal(STAKE_REQ)
      expect(await aegis.arbiterCount()).to.equal(2)
    })

    it("rejects double-registration", async () => {
      const { aegis, governance, arbiterSigners } = await loadFixture(deployFixture)
      await aegis.connect(governance).registerArbiter(arbiterSigners[0].address, ethers.ZeroHash)
      await expect(
        aegis.connect(governance).registerArbiter(arbiterSigners[0].address, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(aegis, "AlreadyActive")
    })

    it("only governance can register/revoke", async () => {
      const { aegis, stranger, arbiterSigners } = await loadFixture(deployFixture)
      await expect(
        aegis.connect(stranger).registerArbiter(arbiterSigners[0].address, ethers.ZeroHash)
      ).to.be.reverted
    })
  })

  describe("openDispute", () => {
    it("opens a case and selects a panel that excludes parties", async () => {
      const ctx = await loadFixture(deployFixture)
      const { aegis, mock, elcpToken, usdcToken, governance, partyA, partyB, arbiterSigners } = ctx
      await registerAndStake(aegis, governance, arbiterSigners)

      await setMockCase(
        mock,
        CASE_KEY,
        partyA.address,
        partyB.address,
        await usdcToken.getAddress(),
        usdc("1000"),
        usdc("50"),
        usdcToken,
        partyA
      )

      const { caseId, panel } = await openAndFulfill(
        aegis,
        ctx.coordinator,
        await mock.getAddress(),
        CASE_KEY,
      )
      expect(panel.length).to.equal(3)
      // unique
      expect(new Set(panel)).to.have.lengthOf(3)
      // does not include parties
      expect(panel).to.not.include(partyA.address)
      expect(panel).to.not.include(partyB.address)

      const c = await aegis.getCase(caseId)
      expect(c.status).to.equal(CASE_OPEN)
      expect(c.partyA).to.equal(partyA.address)
      expect(c.amount).to.equal(usdc("1000"))
      // suppress unused
      void elcpToken
    })

    it("reverts if not enough eligible arbiters", async () => {
      const ctx = await loadFixture(deployFixture)
      const { aegis, mock, usdcToken, governance, partyA, partyB, arbiterSigners } = ctx
      // only 2 staked → panel size 3 cannot be filled
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 2))
      await setMockCase(
        mock,
        CASE_KEY,
        partyA.address,
        partyB.address,
        await usdcToken.getAddress(),
        usdc("100"),
        0n,
        usdcToken,
        partyA
      )
      await expect(
        aegis.openDispute(await mock.getAddress(), CASE_KEY)
      ).to.be.revertedWithCustomError(aegis, "NotEnoughArbiters")
    })

    it("reverts if escrow reports inactive", async () => {
      const ctx = await loadFixture(deployFixture)
      const { aegis, mock, usdcToken, governance, partyA, partyB, arbiterSigners } = ctx
      await registerAndStake(aegis, governance, arbiterSigners)
      // setCase then resolve to make active=false
      await mock.setCase(
        CASE_KEY,
        partyA.address,
        partyB.address,
        await usdcToken.getAddress(),
        usdc("100"),
        0n
      )
      // Mark inactive by directly resolving a case slot via setCase with different key but...
      // simpler: set case with partyA = zero so getDisputeContext returns active=true
      // To exercise the inactive path we need a case where active=false. Easiest is to
      // re-set with the same id but mock has only `setCase` which always sets active=true.
      // Skip — covered by the design: we only need to guarantee the require fires.
      // Instead test that passing an unknown key (active=false default) reverts.
      const unknown = ethers.keccak256(ethers.toUtf8Bytes("missing"))
      await expect(
        aegis.openDispute(await mock.getAddress(), unknown)
      ).to.be.revertedWithCustomError(aegis, "EscrowReportsInactive")
    })

    it("rejects duplicate openDispute for the same (escrow, escrowCaseId)", async () => {
      const ctx = await loadFixture(deployFixture)
      const { aegis, mock, usdcToken, governance, partyA, partyB, arbiterSigners } = ctx
      await registerAndStake(aegis, governance, arbiterSigners)
      await setMockCase(
        mock,
        CASE_KEY,
        partyA.address,
        partyB.address,
        await usdcToken.getAddress(),
        usdc("100"),
        0n,
        usdcToken,
        partyA,
      )
      await aegis.openDispute(await mock.getAddress(), CASE_KEY)
      await expect(
        aegis.openDispute(await mock.getAddress(), CASE_KEY),
      ).to.be.revertedWithCustomError(aegis, "CaseAlreadyLive")
    })

    it("excludes parties from the eligible pool", async () => {
      const ctx = await loadFixture(deployFixture)
      const { aegis, mock, usdcToken, governance, arbiterSigners } = ctx
      await registerAndStake(aegis, governance, arbiterSigners)
      // Use one of the registered arbiters AS partyA — they must not be drawn.
      const partyA = arbiterSigners[0]
      const partyB = arbiterSigners[1]
      await setMockCase(
        mock,
        CASE_KEY,
        partyA.address,
        partyB.address,
        await usdcToken.getAddress(),
        usdc("100"),
        0n,
        usdcToken,
        partyA
      )
      const { panel } = await openAndFulfill(
        aegis,
        ctx.coordinator,
        await mock.getAddress(),
        CASE_KEY,
      )
      expect(panel).to.not.include(partyA.address)
      expect(panel).to.not.include(partyB.address)
    })
  })

  // Helper: set up an open case and return useful refs
  async function openCaseFixture() {
    const ctx = await loadFixture(deployFixture)
    const { aegis, coordinator, mock, usdcToken, governance, partyA, partyB, arbiterSigners } = ctx
    await registerAndStake(aegis, governance, arbiterSigners)
    await setMockCase(
      mock,
      CASE_KEY,
      partyA.address,
      partyB.address,
      await usdcToken.getAddress(),
      usdc("1000"),
      usdc("50"),
      usdcToken,
      partyA
    )
    const { caseId, panel: panelAddrs } = await openAndFulfill(
      aegis,
      coordinator,
      await mock.getAddress(),
      CASE_KEY,
    )
    const panel = panelAddrs.map((a) => a.toLowerCase())
    const panelSigners = arbiterSigners.filter((s) =>
      panel.includes(s.address.toLowerCase())
    )
    return { ...ctx, caseId, panelSigners }
  }

  describe("commit + reveal", () => {
    it("happy path: 3 commits → 3 reveals → median resolves on chain", async () => {
      const { aegis, mock, usdcToken, treasury, partyA, partyB, caseId, panelSigners } =
        await openCaseFixture()

      const votes: Array<{ pct: number; salt: string; digest: string }> = [
        { pct: 30, salt: ethers.id("salt-1"), digest: ethers.id("rationale-1") },
        { pct: 60, salt: ethers.id("salt-2"), digest: ethers.id("rationale-2") },
        { pct: 80, salt: ethers.id("salt-3"), digest: ethers.id("rationale-3") },
      ]
      // commit
      for (let i = 0; i < panelSigners.length; i++) {
        const v = votes[i]
        const hash = await aegis.hashVote(
          panelSigners[i].address,
          caseId,
          v.pct,
          v.salt,
          v.digest
        )
        await aegis.connect(panelSigners[i]).commitVote(caseId, hash)
      }

      // advance into reveal phase
      await time.increase(VOTE_WINDOW + 1)

      // reveal
      for (let i = 0; i < panelSigners.length; i++) {
        const v = votes[i]
        await aegis
          .connect(panelSigners[i])
          .revealVote(caseId, v.pct, v.salt, v.digest)
      }

      // finalize (anyone)
      await aegis.finalize(caseId)

      const c = await aegis.getCase(caseId)
      expect(c.status).to.equal(CASE_RESOLVED)
      // median(30,60,80) = 60
      const settled = await mock.cases(CASE_KEY)
      expect(settled.partyAPercentage).to.equal(60)

      // Fee accounting: 50 USDC paid by mock. 80% (40) split among 3 panelists,
      // 20% (10) to treasury. 40 / 3 = 13 each, dust 1 → treasury = 11.
      const usdcAddr = await usdcToken.getAddress()
      const perPanelist = 13n // (50 * 8000 / 10000) / 3 in 6-dec usdc units when amounts in micro = 50_000_000 → 40_000_000 / 3 = 13_333_333
      // recompute precisely
      const fee = usdc("50") // 50_000_000
      const panelTotal = (fee * BigInt(PANEL_FEE_BPS)) / 10_000n // 40_000_000
      const each = panelTotal / 3n
      const distributed = each * 3n
      const dust = panelTotal - distributed
      const treasuryAmt = fee - panelTotal + dust
      for (const p of panelSigners) {
        expect(await aegis.claimable(p.address, usdcAddr)).to.equal(each)
      }
      expect(await aegis.treasuryAccrued(usdcAddr)).to.equal(treasuryAmt)
      void perPanelist
      void treasury
      void partyA
      void partyB
    })

    it("rejects commit from non-panelist", async () => {
      const { aegis, caseId, stranger } = await openCaseFixture()
      await expect(
        aegis.connect(stranger).commitVote(caseId, ethers.id("x"))
      ).to.be.revertedWithCustomError(aegis, "NotPanelist")
    })

    it("rejects reveal with mismatched hash", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      const me = panelSigners[0]
      const realHash = await aegis.hashVote(
        me.address,
        caseId,
        50,
        ethers.id("a"),
        ethers.id("b")
      )
      await aegis.connect(me).commitVote(caseId, realHash)
      await time.increase(VOTE_WINDOW + 1)
      // try reveal with different pct
      await expect(
        aegis.connect(me).revealVote(caseId, 70, ethers.id("a"), ethers.id("b"))
      ).to.be.revertedWithCustomError(aegis, "CommitMismatch")
    })

    it("rejects reveal before commit window closes", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      const me = panelSigners[0]
      const hash = await aegis.hashVote(
        me.address,
        caseId,
        50,
        ethers.id("a"),
        ethers.id("b")
      )
      await aegis.connect(me).commitVote(caseId, hash)
      await expect(
        aegis.connect(me).revealVote(caseId, 50, ethers.id("a"), ethers.id("b"))
      ).to.be.revertedWithCustomError(aegis, "CommitWindowOpen")
    })
  })

  describe("recusal", () => {
    it("recused panelist is replaced with a fresh draw and lock released", async () => {
      const ctx = await openCaseFixture()
      const { aegis, caseId, panelSigners, arbiterSigners } = ctx
      const me = panelSigners[0]
      const oldPanel = (await aegis.getPanel(caseId)).map((a) => a.toLowerCase())

      await aegis.connect(me).recuse(caseId)

      const newPanel = (await aegis.getPanel(caseId)).map((a) => a.toLowerCase())
      // Same length
      expect(newPanel.length).to.equal(oldPanel.length)
      // The recused address is gone
      expect(newPanel).to.not.include(me.address.toLowerCase())
      // The replacement is from the registered roster, not a party
      const knownArbiters = arbiterSigners.map((s) => s.address.toLowerCase())
      for (const p of newPanel) {
        expect(knownArbiters).to.include(p)
      }

      // Recused panelist's lock was released
      expect(await aegis.lockedStake(me.address)).to.equal(0)
    })

    it("recused panelist can fully unstake afterward", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      const me = panelSigners[0]
      await aegis.connect(me).recuse(caseId)
      // Unstaking the full bond now succeeds because lock was released.
      await aegis.connect(me).unstake(STAKE_REQ)
      const a = await aegis.arbiters(me.address)
      expect(a.stakedAmount).to.equal(0)
    })

    it("rejects recusal after the panelist has committed", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      const me = panelSigners[0]
      const h = await aegis.hashVote(
        me.address,
        caseId,
        50,
        ethers.id("s"),
        ethers.id("d"),
      )
      await aegis.connect(me).commitVote(caseId, h)
      await expect(
        aegis.connect(me).recuse(caseId),
      ).to.be.revertedWithCustomError(aegis, "CannotRecuseAfterCommit")
    })

    it("rejects recusal after the commit window closes", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      const me = panelSigners[0]
      await time.increase(VOTE_WINDOW + 1)
      await expect(
        aegis.connect(me).recuse(caseId),
      ).to.be.revertedWithCustomError(aegis, "CommitWindowClosed")
    })

    it("rejects recusal from a non-panelist", async () => {
      const { aegis, caseId, stranger } = await openCaseFixture()
      await expect(
        aegis.connect(stranger).recuse(caseId),
      ).to.be.revertedWithCustomError(aegis, "NotPanelist")
    })
  })

  describe("finalize gate (no first-quorum-decides)", () => {
    it("rejects finalize while reveal window is still open and not all revealed", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      // Two of three commit + reveal.
      const votes = [
        { pct: 30, salt: ethers.id("a"), digest: ethers.id("ra") },
        { pct: 50, salt: ethers.id("b"), digest: ethers.id("rb") },
      ]
      for (let i = 0; i < votes.length; i++) {
        const v = votes[i]
        const h = await aegis.hashVote(panelSigners[i].address, caseId, v.pct, v.salt, v.digest)
        await aegis.connect(panelSigners[i]).commitVote(caseId, h)
      }
      await time.increase(VOTE_WINDOW + 1)
      for (let i = 0; i < votes.length; i++) {
        const v = votes[i]
        await aegis.connect(panelSigners[i]).revealVote(caseId, v.pct, v.salt, v.digest)
      }
      // Quorum (2 of 3) is reached but the third panelist hasn't revealed
      // and the reveal window is still open. Finalize must wait.
      await expect(aegis.finalize(caseId)).to.be.revertedWithCustomError(
        aegis,
        "RevealWindowOpen",
      )
    })

    it("resolves immediately once ALL panelists have revealed", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      const votes = [
        { pct: 30, salt: ethers.id("a"), digest: ethers.id("ra") },
        { pct: 50, salt: ethers.id("b"), digest: ethers.id("rb") },
        { pct: 80, salt: ethers.id("c"), digest: ethers.id("rc") },
      ]
      for (let i = 0; i < panelSigners.length; i++) {
        const v = votes[i]
        const h = await aegis.hashVote(panelSigners[i].address, caseId, v.pct, v.salt, v.digest)
        await aegis.connect(panelSigners[i]).commitVote(caseId, h)
      }
      await time.increase(VOTE_WINDOW + 1)
      for (let i = 0; i < panelSigners.length; i++) {
        const v = votes[i]
        await aegis.connect(panelSigners[i]).revealVote(caseId, v.pct, v.salt, v.digest)
      }
      // No window advance; should resolve because all 3 revealed.
      await aegis.finalize(caseId)
      const c = await aegis.getCase(caseId)
      expect(c.status).to.equal(CASE_RESOLVED)
    })

    it("resolves with quorum once reveal window has expired", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      // Only 2 of 3 reveal; advance past reveal window.
      const votes = [
        { pct: 20, salt: ethers.id("a"), digest: ethers.id("ra") },
        { pct: 60, salt: ethers.id("b"), digest: ethers.id("rb") },
      ]
      for (let i = 0; i < votes.length; i++) {
        const v = votes[i]
        const h = await aegis.hashVote(panelSigners[i].address, caseId, v.pct, v.salt, v.digest)
        await aegis.connect(panelSigners[i]).commitVote(caseId, h)
      }
      await time.increase(VOTE_WINDOW + 1)
      for (let i = 0; i < votes.length; i++) {
        const v = votes[i]
        await aegis.connect(panelSigners[i]).revealVote(caseId, v.pct, v.salt, v.digest)
      }
      await time.increase(REVEAL_WINDOW + 1)
      const tx = await aegis.finalize(caseId)
      const c = await aegis.getCase(caseId)
      expect(c.status).to.equal(CASE_RESOLVED)
      // Median of 2 reveals = lower middle = 20. Confirm via event.
      const receipt = await tx.wait()
      const resolved = receipt!.logs
        .map((l) => {
          try {
            return aegis.interface.parseLog(l as any)
          } catch {
            return null
          }
        })
        .find((e) => e?.name === "CaseResolved")
      expect(resolved!.args.medianPercentage).to.equal(20)
    })
  })

  describe("timeout + redraw + default 50/50", () => {
    it("redraws panel and slashes non-revealers on first stall", async () => {
      const ctx = await openCaseFixture()
      const { aegis, coordinator, elcpToken, treasury, panelSigners, caseId } = ctx
      // No commits, no reveals. Advance past reveal + grace.
      await time.increase(VOTE_WINDOW + REVEAL_WINDOW + GRACE_WINDOW + 1)
      const elcpAddr = await elcpToken.getAddress()
      const treasuryBefore = await aegis.treasuryAccrued(elcpAddr)

      // Finalize: slash + request VRF for the redraw.
      const tx = await aegis.finalize(caseId)
      const receipt = await tx.wait()
      const stalled = receipt!.logs
        .map((l) => {
          try {
            return aegis.interface.parseLog(l as any)
          } catch {
            return null
          }
        })
        .find((e) => e?.name === "PanelStalled")
      expect(stalled).to.exist
      expect(stalled!.args.round).to.equal(0)

      // Each non-revealing panelist (3) loses their full bond.
      const slashedExpected = STAKE_REQ * 3n
      expect(await aegis.treasuryAccrued(elcpAddr)).to.equal(treasuryBefore + slashedExpected)

      // Case is awaiting the redraw VRF.
      let c = await aegis.getCase(caseId)
      expect(c.status).to.equal(CASE_AWAITING_PANEL)
      expect(c.round).to.equal(1)

      // Pull the redraw requestId and fulfill.
      const redrawRequested = receipt!.logs
        .map((l) => {
          try {
            return coordinator.interface.parseLog(l as any)
          } catch {
            return null
          }
        })
        .find((e) => e?.name === "RandomnessRequested")
      const requestId = redrawRequested!.args.requestId as bigint
      await coordinator.fulfillWithSingleWord(requestId, 0xfeedbabec0deba5en)

      c = await aegis.getCase(caseId)
      expect(c.status).to.equal(CASE_OPEN)

      const newPanel = await aegis.getPanel(caseId)
      const orig = panelSigners.map((s) => s.address.toLowerCase())
      for (const p of newPanel) {
        expect(orig).to.not.include(p.toLowerCase())
      }
      void treasury
    })

    it("only slashes the bond, not the entire stake of an over-staked panelist", async () => {
      // Set up a panelist with double the minimum stake.
      const ctx = await loadFixture(deployFixture)
      const { aegis, mock, governance, elcpToken, partyA, partyB, arbiterSigners, usdcToken } = ctx
      // Register all 6, but stake DOUBLE the requirement on the first one.
      for (const a of arbiterSigners) {
        const cid = ethers.keccak256(ethers.toUtf8Bytes(await a.getAddress()))
        await aegis.connect(governance).registerArbiter(await a.getAddress(), cid)
      }
      // Default everyone to STAKE_REQ; bump arbiter[0] to 2 × STAKE_REQ.
      for (const a of arbiterSigners) await aegis.connect(a).stake(STAKE_REQ)
      await aegis.connect(arbiterSigners[0]).stake(STAKE_REQ)

      await mock.setCase(
        CASE_KEY,
        partyA.address,
        partyB.address,
        await usdcToken.getAddress(),
        usdc("100"),
        0n,
      )
      const { caseId, panel: panelAddrs } = await openAndFulfill(
        aegis,
        ctx.coordinator,
        await mock.getAddress(),
        CASE_KEY,
      )
      const panel = panelAddrs.map((a) => a.toLowerCase())

      // Stall everything.
      await time.increase(VOTE_WINDOW + REVEAL_WINDOW + GRACE_WINDOW + 1)
      await aegis.finalize(caseId)

      // Each panelist who was on the case lost exactly STAKE_REQ.
      for (const addr of panel) {
        const original = arbiterSigners.find((s) => s.address.toLowerCase() === addr)!
        const a = await aegis.arbiters(original.address)
        if (original.address === arbiterSigners[0].address) {
          // Started with 2 × STAKE_REQ, lost STAKE_REQ → STAKE_REQ remains.
          expect(a.stakedAmount).to.equal(STAKE_REQ)
        } else {
          // Started with STAKE_REQ, lost STAKE_REQ → 0 remains.
          expect(a.stakedAmount).to.equal(0)
        }
      }
      void elcpToken
    })

    it("falls back to 50/50 default when round 1 also stalls", async () => {
      const ctx = await openCaseFixture()
      const { aegis, coordinator, mock, caseId } = ctx
      // Stall round 0 — finalize emits PanelStalled + requests VRF.
      await time.increase(VOTE_WINDOW + REVEAL_WINDOW + GRACE_WINDOW + 1)
      const stallTx = await aegis.finalize(caseId)
      const stallReceipt = await stallTx.wait()
      const redrawReq = stallReceipt!.logs
        .map((l) => {
          try {
            return coordinator.interface.parseLog(l as any)
          } catch {
            return null
          }
        })
        .find((e) => e?.name === "RandomnessRequested")
      // Fulfill so the new panel is seated.
      await coordinator.fulfillWithSingleWord(
        redrawReq!.args.requestId as bigint,
        0x1234567890abcdefn,
      )

      // Stall round 1 too — no fulfillment after this; default 50/50 fires.
      await time.increase(VOTE_WINDOW + REVEAL_WINDOW + GRACE_WINDOW + 1)
      await aegis.finalize(caseId)

      const c = await aegis.getCase(caseId)
      expect(c.status).to.equal(CASE_DEFAULT_RESOLVED)
      const settled = await mock.cases(CASE_KEY)
      expect(settled.partyAPercentage).to.equal(50) // DEFAULT_PERCENTAGE
    })
  })

  describe("governance", () => {
    it("setPolicy updates parameters", async () => {
      const { aegis, governance, treasury } = await loadFixture(deployFixture)
      await aegis.connect(governance).setPolicy({
        panelSize: 5,
        voteWindow: 1000,
        revealWindow: 2000,
        graceWindow: 500,
        stakeRequirement: elcp("200"),
        panelFeeBps: 7000,
        treasury: treasury.address,
      })
      const p = await aegis.policy()
      expect(p.panelSize).to.equal(5)
      expect(p.voteWindow).to.equal(1000)
      expect(p.panelFeeBps).to.equal(7000)
    })

    it("withdrawTreasury moves slashed stake out", async () => {
      const ctx = await loadFixture(deployFixture)
      const { aegis, governance, treasury, elcpToken, arbiterSigners } = ctx
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      await aegis.connect(governance).revokeArbiter(arbiterSigners[0].address)
      const elcpAddr = await elcpToken.getAddress()
      const before = await elcpToken.balanceOf(treasury.address)
      await aegis.connect(governance).withdrawTreasury(elcpAddr, treasury.address, STAKE_REQ)
      expect(await elcpToken.balanceOf(treasury.address)).to.equal(before + STAKE_REQ)
      expect(await aegis.treasuryAccrued(elcpAddr)).to.equal(0)
    })

    it("pauseNewCases blocks openDispute", async () => {
      const ctx = await loadFixture(deployFixture)
      const { aegis, mock, governance, usdcToken, partyA, partyB, arbiterSigners } = ctx
      await registerAndStake(aegis, governance, arbiterSigners)
      await aegis.connect(governance).setNewCasesPaused(true)
      await mock.setCase(
        CASE_KEY,
        partyA.address,
        partyB.address,
        await usdcToken.getAddress(),
        usdc("1"),
        0n
      )
      await expect(
        aegis.openDispute(await mock.getAddress(), CASE_KEY)
      ).to.be.revertedWithCustomError(aegis, "CasePaused")
    })
  })

  describe("stake locking while on a panel", () => {
    it("blocks unstake that would drop free stake below 0 (the dodge)", async () => {
      const ctx = await openCaseFixture()
      const { aegis, panelSigners } = ctx
      const me = panelSigners[0]
      // Try to unstake the entire bond.
      await expect(
        aegis.connect(me).unstake(STAKE_REQ),
      ).to.be.revertedWithCustomError(aegis, "StakeLocked")
    })

    it("releases the lock when the case resolves cleanly", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      const votes = [
        { pct: 30, salt: ethers.id("a"), digest: ethers.id("ra") },
        { pct: 50, salt: ethers.id("b"), digest: ethers.id("rb") },
        { pct: 70, salt: ethers.id("c"), digest: ethers.id("rc") },
      ]
      for (let i = 0; i < panelSigners.length; i++) {
        const v = votes[i]
        const h = await aegis.hashVote(panelSigners[i].address, caseId, v.pct, v.salt, v.digest)
        await aegis.connect(panelSigners[i]).commitVote(caseId, h)
      }
      await time.increase(VOTE_WINDOW + 1)
      for (let i = 0; i < panelSigners.length; i++) {
        const v = votes[i]
        await aegis.connect(panelSigners[i]).revealVote(caseId, v.pct, v.salt, v.digest)
      }
      await aegis.finalize(caseId)

      // After resolution, lockedStake is zero and unstake works.
      for (const p of panelSigners) {
        expect(await aegis.lockedStake(p.address)).to.equal(0)
      }
      await aegis.connect(panelSigners[0]).unstake(STAKE_REQ)
      const a = await aegis.arbiters(panelSigners[0].address)
      expect(a.stakedAmount).to.equal(0)
    })

    it("eligibility excludes arbiters whose free stake is too low", async () => {
      const ctx = await openCaseFixture()
      // Open case 1 already locks stakeRequirement on its 3 panelists.
      // If we try to open a SECOND case, we'd need 3 fresh eligible arbiters
      // beyond the original panel. Fixture has 6 arbiters total, panel = 3,
      // so 3 free remain — exactly enough for one more case.
      const { aegis, mock, usdcToken, partyA, partyB } = ctx
      const k2 = ethers.keccak256(ethers.toUtf8Bytes("second"))
      await mock.setCase(
        k2,
        partyA.address,
        partyB.address,
        await usdcToken.getAddress(),
        usdc("100"),
        0n,
      )
      // Should succeed — 3 arbiters with free stake remain. Drive the
      // VRF fulfillment so the second panel actually locks their stake.
      await openAndFulfill(aegis, ctx.coordinator, await mock.getAddress(), k2)

      // A third case should now fail — no free arbiters left.
      const k3 = ethers.keccak256(ethers.toUtf8Bytes("third"))
      await mock.setCase(
        k3,
        partyA.address,
        partyB.address,
        await usdcToken.getAddress(),
        usdc("100"),
        0n,
      )
      await expect(
        aegis.openDispute(await mock.getAddress(), k3),
      ).to.be.revertedWithCustomError(aegis, "NotEnoughArbiters")
    })
  })

  describe("claim", () => {
    it("panelists can claim accrued fees", async () => {
      const ctx = await openCaseFixture()
      const { aegis, usdcToken, panelSigners, caseId } = ctx
      const votes = [
        { pct: 40, salt: ethers.id("s1"), digest: ethers.id("d1") },
        { pct: 50, salt: ethers.id("s2"), digest: ethers.id("d2") },
        { pct: 60, salt: ethers.id("s3"), digest: ethers.id("d3") },
      ]
      for (let i = 0; i < panelSigners.length; i++) {
        const v = votes[i]
        const h = await aegis.hashVote(panelSigners[i].address, caseId, v.pct, v.salt, v.digest)
        await aegis.connect(panelSigners[i]).commitVote(caseId, h)
      }
      await time.increase(VOTE_WINDOW + 1)
      for (let i = 0; i < panelSigners.length; i++) {
        const v = votes[i]
        await aegis.connect(panelSigners[i]).revealVote(caseId, v.pct, v.salt, v.digest)
      }
      await aegis.finalize(caseId)

      const usdcAddr = await usdcToken.getAddress()
      const me = panelSigners[0]
      const before = await usdcToken.balanceOf(me.address)
      const owed = await aegis.claimable(me.address, usdcAddr)
      await aegis.connect(me).claim(usdcAddr)
      expect(await usdcToken.balanceOf(me.address)).to.equal(before + owed)
      expect(await aegis.claimable(me.address, usdcAddr)).to.equal(0)
    })

    it("reverts on empty claim", async () => {
      const { aegis, stranger, usdcToken } = await loadFixture(deployFixture)
      await expect(
        aegis.connect(stranger).claim(await usdcToken.getAddress())
      ).to.be.revertedWithCustomError(aegis, "NothingToClaim")
    })
  })

  describe("hashVote helper agrees with on-chain check", () => {
    it("commit-reveal succeeds when hash is computed via hashVote()", async () => {
      const { aegis, caseId, panelSigners } = await openCaseFixture()
      const me = panelSigners[0]
      const pct = 42
      const salt = ethers.id("hello")
      const digest = ethers.id("rationale")
      const h = await aegis.hashVote(me.address, caseId, pct, salt, digest)
      await aegis.connect(me).commitVote(caseId, h)
      await time.increase(VOTE_WINDOW + 1)
      await expect(aegis.connect(me).revealVote(caseId, pct, salt, digest))
        .to.emit(aegis, "Revealed")
        .withArgs(caseId, me.address, pct, digest)
    })
  })

  // suppress unused-import warning for `network`
  void network
})
