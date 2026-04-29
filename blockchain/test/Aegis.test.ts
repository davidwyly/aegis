import { expect } from "chai"
import { ethers } from "hardhat"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import type {
  Aegis,
  MockArbitrableEscrow,
  MockERC20,
  MockVRFCoordinator,
} from "../typechain-types"
import type { Signer } from "ethers"

// ============================================================
// Test config (mirrors the spec-frozen defaults)
// ============================================================

const VRF_KEY_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000001"
const VRF_SUB_ID = 1n
const VRF_CONFIRMATIONS = 3
const VRF_CALLBACK_GAS = 500_000

const elcp = (n: string) => ethers.parseEther(n)
const usdc = (n: string) => ethers.parseUnits(n, 6)

const COMMIT_WINDOW = 60 * 60 * 24 // 24h, D7
const REVEAL_WINDOW = 60 * 60 * 24 // 24h, D8
const GRACE_WINDOW = 60 * 60 * 12 // 12h
const APPEAL_WINDOW = 60 * 60 * 24 * 7 // 7d, D9
const REPEAT_COOLDOWN = 60 * 60 * 24 * 90 // 90d, D13
const STAKE_REQ = elcp("100")
const APPEAL_FEE_BPS = 250 // 2.5%, D2
const PER_ARBITER_FEE_BPS = 250 // 2.5%, D4

// CaseState enum order — matches Aegis.sol
const STATE_NONE = 0
const STATE_AWAITING_ARBITER = 1
const STATE_VOTING = 2
const STATE_APPEALABLE_RESOLVED = 3
const STATE_AWAITING_APPEAL_PANEL = 4
const STATE_RESOLVED = 5
const STATE_DEFAULTED = 6

// ============================================================
// Fixture: ELCP + USDC + Aegis + MockEscrow + 6 arbiters staked
// ============================================================

async function deployFixture() {
  const signers = await ethers.getSigners()
  const [governance, treasury, partyA, partyB, ...rest] = signers
  const arbiterSigners = rest.slice(0, 6)
  const stranger = rest[6]

  const ELCP = await ethers.getContractFactory("MockERC20")
  const elcpToken = (await ELCP.deploy("Eclipse", "ELCP", 18)) as unknown as MockERC20
  const USDC = await ethers.getContractFactory("MockERC20")
  const usdcToken = (await USDC.deploy("USD Coin", "USDC", 6)) as unknown as MockERC20

  const Coord = await ethers.getContractFactory("MockVRFCoordinator")
  const coordinator = (await Coord.deploy()) as unknown as MockVRFCoordinator

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
      commitWindow: COMMIT_WINDOW,
      revealWindow: REVEAL_WINDOW,
      graceWindow: GRACE_WINDOW,
      appealWindow: APPEAL_WINDOW,
      repeatArbiterCooldown: REPEAT_COOLDOWN,
      stakeRequirement: STAKE_REQ,
      appealFeeBps: APPEAL_FEE_BPS,
      perArbiterFeeBps: PER_ARBITER_FEE_BPS,
      treasury: treasury.address,
    }
  )) as unknown as Aegis

  const Mock = await ethers.getContractFactory("MockArbitrableEscrow")
  const mock = (await Mock.deploy(
    await aegis.getAddress()
  )) as unknown as MockArbitrableEscrow

  // Mint + approve ELCP for arbiters and stranger.
  for (const s of [...arbiterSigners, stranger]) {
    await elcpToken.mint(s.address, elcp("10000"))
    await elcpToken.connect(s).approve(await aegis.getAddress(), ethers.MaxUint256)
  }
  // Mint + approve USDC for the parties (so they can pay the appeal fee).
  for (const s of [partyA, partyB]) {
    await usdcToken.mint(s.address, usdc("100000"))
    await usdcToken.connect(s).approve(await aegis.getAddress(), ethers.MaxUint256)
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

// ============================================================
// Helpers
// ============================================================

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

async function stageMockCase(
  mock: MockArbitrableEscrow,
  usdcToken: MockERC20,
  caseId: string,
  partyA: string,
  partyB: string,
  amount: bigint,
  feeAmount: bigint
) {
  const feeToken = await usdcToken.getAddress()
  await mock.setCase(caseId, partyA, partyB, feeToken, amount, feeAmount)
  await usdcToken.mint(await mock.getAddress(), feeAmount)
}

/**
 * Open a dispute and let VRF fulfill the original-arbiter draw.
 * Returns the assigned arbiter and the Aegis caseId.
 */
async function openAndDraw(
  aegis: Aegis,
  coordinator: MockVRFCoordinator,
  escrow: string,
  escrowCaseId: string,
  randomWord: bigint = 0xdeadbeefn
): Promise<{ caseId: string; arbiter: string }> {
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
  const drawn = fulfillReceipt!.logs
    .map((l) => {
      try {
        return aegis.interface.parseLog(l as any)
      } catch {
        return null
      }
    })
    .find((e) => e?.name === "ArbiterDrawn")
  const arbiter = drawn!.args.arbiter as string
  return { caseId, arbiter }
}

function makeCommit(
  arbiter: string,
  caseId: string,
  partyAPercentage: number,
  salt: string,
  rationaleDigest: string
): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "uint16", "bytes32", "bytes32"],
      [arbiter, caseId, partyAPercentage, salt, rationaleDigest]
    )
  )
}

/** Commit + reveal a single arbiter, returning the (percentage, digest) used. */
async function commitAndReveal(
  aegis: Aegis,
  arbiterSigner: Signer,
  caseId: string,
  partyAPercentage: number
): Promise<{ digest: string; salt: string }> {
  const arbiter = await arbiterSigner.getAddress()
  const salt = ethers.hexlify(ethers.randomBytes(32))
  const digest = ethers.keccak256(ethers.toUtf8Bytes(`rationale-${arbiter}-${caseId}`))
  const hash = makeCommit(arbiter, caseId, partyAPercentage, salt, digest)
  await aegis.connect(arbiterSigner).commitVote(caseId, hash)
  await time.increase(COMMIT_WINDOW + 1)
  await aegis.connect(arbiterSigner).revealVote(caseId, partyAPercentage, salt, digest)
  return { digest, salt }
}

const CASE_KEY = ethers.keccak256(ethers.toUtf8Bytes("test-case-1"))

// ============================================================
// Tests
// ============================================================

describe("Aegis (single-arbiter + appeal-of-3)", () => {
  describe("constructor + policy", () => {
    it("initializes with the given policy and grants governance role", async () => {
      const { aegis, governance, treasury } = await loadFixture(deployFixture)
      expect(await aegis.hasRole(await aegis.GOVERNANCE_ROLE(), governance.address)).to.equal(true)
      const p = await aegis.policy()
      expect(p.commitWindow).to.equal(COMMIT_WINDOW)
      expect(p.revealWindow).to.equal(REVEAL_WINDOW)
      expect(p.appealWindow).to.equal(APPEAL_WINDOW)
      expect(p.repeatArbiterCooldown).to.equal(REPEAT_COOLDOWN)
      expect(p.stakeRequirement).to.equal(STAKE_REQ)
      expect(p.appealFeeBps).to.equal(APPEAL_FEE_BPS)
      expect(p.perArbiterFeeBps).to.equal(PER_ARBITER_FEE_BPS)
      expect(p.treasury).to.equal(treasury.address)
    })

    it("rejects invalid policy (zero windows / treasury / oversized bps)", async () => {
      const { governance, treasury } = await loadFixture(deployFixture)
      const ELCP = await ethers.getContractFactory("MockERC20")
      const elcpToken = (await ELCP.deploy("E", "E", 18)) as unknown as MockERC20
      const Coord = await ethers.getContractFactory("MockVRFCoordinator")
      const coord = (await Coord.deploy()) as unknown as MockVRFCoordinator
      const Aegis = await ethers.getContractFactory("Aegis")
      const vrf = {
        keyHash: VRF_KEY_HASH,
        subscriptionId: VRF_SUB_ID,
        requestConfirmations: VRF_CONFIRMATIONS,
        callbackGasLimit: VRF_CALLBACK_GAS,
      }
      const base = {
        commitWindow: COMMIT_WINDOW,
        revealWindow: REVEAL_WINDOW,
        graceWindow: GRACE_WINDOW,
        appealWindow: APPEAL_WINDOW,
        repeatArbiterCooldown: REPEAT_COOLDOWN,
        stakeRequirement: STAKE_REQ,
        appealFeeBps: APPEAL_FEE_BPS,
        perArbiterFeeBps: PER_ARBITER_FEE_BPS,
        treasury: treasury.address,
      }
      const args = [
        governance.address,
        await elcpToken.getAddress(),
        await coord.getAddress(),
        vrf,
      ] as const

      await expect(
        Aegis.deploy(...args, { ...base, commitWindow: 0 })
      ).to.be.revertedWithCustomError(await Aegis.deploy(...args, base), "InvalidPolicy")
      await expect(
        Aegis.deploy(...args, { ...base, appealWindow: 0 })
      ).to.be.revertedWithCustomError(await Aegis.deploy(...args, base), "InvalidPolicy")
      await expect(
        Aegis.deploy(...args, { ...base, treasury: ethers.ZeroAddress })
      ).to.be.revertedWithCustomError(await Aegis.deploy(...args, base), "InvalidPolicy")
      await expect(
        Aegis.deploy(...args, { ...base, appealFeeBps: 10_001 })
      ).to.be.revertedWithCustomError(await Aegis.deploy(...args, base), "InvalidPolicy")
    })
  })

  describe("arbiter roster + staking", () => {
    it("registers, stakes, and revokes an arbiter", async () => {
      const { aegis, governance, treasury, elcpToken, arbiterSigners } =
        await loadFixture(deployFixture)
      const a = arbiterSigners[0]
      const cid = ethers.keccak256(ethers.toUtf8Bytes("creds"))
      await aegis.connect(governance).registerArbiter(a.address, cid)
      await aegis.connect(a).stake(STAKE_REQ)
      expect((await aegis.arbiters(a.address)).stakedAmount).to.equal(STAKE_REQ)
      await aegis.connect(governance).revokeArbiter(a.address)
      expect((await aegis.arbiters(a.address)).active).to.equal(false)
      // Slashed stake → treasury accrued.
      expect(await aegis.treasuryAccrued(await elcpToken.getAddress())).to.equal(STAKE_REQ)
    })
  })

  describe("openDispute + original draw", () => {
    it("opens a case, requests VRF, and seats one arbiter on fulfill", async () => {
      const { aegis, coordinator, mock, governance, partyA, partyB, usdcToken, arbiterSigners } =
        await loadFixture(deployFixture)
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      await stageMockCase(
        mock,
        usdcToken,
        CASE_KEY,
        partyA.address,
        partyB.address,
        usdc("1000"),
        usdc("50") // 5% fee
      )

      const { caseId, arbiter } = await openAndDraw(
        aegis,
        coordinator,
        await mock.getAddress(),
        CASE_KEY
      )

      expect(arbiter).to.not.equal(ethers.ZeroAddress)
      const c = await aegis.getCase(caseId)
      expect(c.state).to.equal(STATE_VOTING)
      expect(c.originalArbiter).to.equal(arbiter)
      expect(c.partyA).to.equal(partyA.address)
      expect(c.partyB).to.equal(partyB.address)
      expect(c.amount).to.equal(usdc("1000"))
      // Stake locked.
      expect(await aegis.lockedStake(arbiter)).to.equal(STAKE_REQ)
      // D13 cooldown stamped.
      const pairKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address"],
          partyA.address.toLowerCase() < partyB.address.toLowerCase()
            ? [partyA.address, partyB.address]
            : [partyB.address, partyA.address]
        )
      )
      expect(await aegis.lastArbitratedAt(pairKey, arbiter)).to.be.gt(0)
    })

    it("reverts NotEnoughArbiters when the eligible pool is empty", async () => {
      const { aegis, mock, partyA, partyB, usdcToken } = await loadFixture(deployFixture)
      // No arbiters registered.
      await stageMockCase(
        mock,
        usdcToken,
        CASE_KEY,
        partyA.address,
        partyB.address,
        usdc("1000"),
        usdc("50")
      )
      await expect(
        aegis.openDispute(await mock.getAddress(), CASE_KEY)
      ).to.be.revertedWithCustomError(aegis, "NotEnoughArbiters")
    })

    it("rejects opening twice on the same (escrow, escrowCaseId)", async () => {
      const { aegis, coordinator, mock, governance, partyA, partyB, usdcToken, arbiterSigners } =
        await loadFixture(deployFixture)
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      await stageMockCase(
        mock,
        usdcToken,
        CASE_KEY,
        partyA.address,
        partyB.address,
        usdc("1000"),
        usdc("50")
      )
      await openAndDraw(aegis, coordinator, await mock.getAddress(), CASE_KEY)
      await expect(
        aegis.openDispute(await mock.getAddress(), CASE_KEY)
      ).to.be.revertedWithCustomError(aegis, "CaseAlreadyLive")
    })
  })

  describe("commit + reveal (original arbiter)", () => {
    it("happy path: arbiter commits then reveals, case → AppealableResolved", async () => {
      const { aegis, coordinator, mock, governance, partyA, partyB, usdcToken, arbiterSigners } =
        await loadFixture(deployFixture)
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      await stageMockCase(
        mock,
        usdcToken,
        CASE_KEY,
        partyA.address,
        partyB.address,
        usdc("1000"),
        usdc("50")
      )
      const { caseId, arbiter } = await openAndDraw(
        aegis,
        coordinator,
        await mock.getAddress(),
        CASE_KEY
      )
      const arbiterSigner = arbiterSigners.find(
        async (s) => (await s.getAddress()) === arbiter
      ) as Signer
      // Find the actual signer matching the drawn arbiter.
      const signer = arbiterSigners.find((s) => s.address === arbiter)!

      await commitAndReveal(aegis, signer, caseId, 60)

      const c = await aegis.getCase(caseId)
      expect(c.state).to.equal(STATE_APPEALABLE_RESOLVED)
      expect(c.originalRevealed).to.equal(true)
      expect(c.originalPercentage).to.equal(60)
      expect(c.appealDeadline).to.be.gt(0)
    })

    it("rejects commit from non-assigned address", async () => {
      const { aegis, coordinator, mock, governance, partyA, partyB, usdcToken, arbiterSigners, stranger } =
        await loadFixture(deployFixture)
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      await stageMockCase(
        mock,
        usdcToken,
        CASE_KEY,
        partyA.address,
        partyB.address,
        usdc("1000"),
        usdc("50")
      )
      const { caseId } = await openAndDraw(aegis, coordinator, await mock.getAddress(), CASE_KEY)
      await expect(
        aegis.connect(stranger).commitVote(caseId, ethers.keccak256(ethers.toUtf8Bytes("x")))
      ).to.be.revertedWithCustomError(aegis, "NotAssignedArbiter")
    })

    it("rejects reveal whose hash doesn't match the commit", async () => {
      const { aegis, coordinator, mock, governance, partyA, partyB, usdcToken, arbiterSigners } =
        await loadFixture(deployFixture)
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      await stageMockCase(
        mock,
        usdcToken,
        CASE_KEY,
        partyA.address,
        partyB.address,
        usdc("1000"),
        usdc("50")
      )
      const { caseId, arbiter } = await openAndDraw(
        aegis,
        coordinator,
        await mock.getAddress(),
        CASE_KEY
      )
      const signer = arbiterSigners.find((s) => s.address === arbiter)!
      const salt = ethers.hexlify(ethers.randomBytes(32))
      const digest = ethers.keccak256(ethers.toUtf8Bytes("d"))
      const hash = makeCommit(arbiter, caseId, 60, salt, digest)
      await aegis.connect(signer).commitVote(caseId, hash)
      await time.increase(COMMIT_WINDOW + 1)
      // Reveal with a different percentage → hash mismatch.
      await expect(
        aegis.connect(signer).revealVote(caseId, 70, salt, digest)
      ).to.be.revertedWithCustomError(aegis, "CommitMismatch")
    })
  })

  describe("finalize: no-appeal happy path with D1(c) rebate", () => {
    it("settles with verdict-weighted party rebate after appeal window", async () => {
      const {
        aegis,
        coordinator,
        mock,
        governance,
        partyA,
        partyB,
        usdcToken,
        arbiterSigners,
      } = await loadFixture(deployFixture)
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      const amount = usdc("1000")
      const fee = usdc("50") // 5% — matches the 2.5%+2.5% pot model
      await stageMockCase(
        mock,
        usdcToken,
        CASE_KEY,
        partyA.address,
        partyB.address,
        amount,
        fee
      )
      const { caseId, arbiter } = await openAndDraw(
        aegis,
        coordinator,
        await mock.getAddress(),
        CASE_KEY
      )
      const signer = arbiterSigners.find((s) => s.address === arbiter)!
      await commitAndReveal(aegis, signer, caseId, 60) // 60% to partyA

      // Appeal window expires.
      await time.increase(APPEAL_WINDOW + 1)
      await aegis.finalize(caseId)

      const usdcAddr = await usdcToken.getAddress()
      // Arbiter: half of 5% = 2.5% of amount = usdc("25").
      expect(await aegis.claimable(arbiter, usdcAddr)).to.equal(usdc("25"))
      // Rebate: usdc("25"), split 60/40 by verdict.
      expect(await aegis.claimable(partyA.address, usdcAddr)).to.equal(usdc("15"))
      expect(await aegis.claimable(partyB.address, usdcAddr)).to.equal(usdc("10"))

      const c = await aegis.getCase(caseId)
      expect(c.state).to.equal(STATE_RESOLVED)
      expect(c.feesDistributed).to.equal(true)
      // Stake unlocked.
      expect(await aegis.lockedStake(arbiter)).to.equal(0)
    })

    it("rejects finalize before the appeal window expires", async () => {
      const { aegis, coordinator, mock, governance, partyA, partyB, usdcToken, arbiterSigners } =
        await loadFixture(deployFixture)
      await registerAndStake(aegis, governance, arbiterSigners.slice(0, 3))
      await stageMockCase(
        mock,
        usdcToken,
        CASE_KEY,
        partyA.address,
        partyB.address,
        usdc("1000"),
        usdc("50")
      )
      const { caseId, arbiter } = await openAndDraw(
        aegis,
        coordinator,
        await mock.getAddress(),
        CASE_KEY
      )
      const signer = arbiterSigners.find((s) => s.address === arbiter)!
      await commitAndReveal(aegis, signer, caseId, 50)

      await expect(aegis.finalize(caseId)).to.be.revertedWithCustomError(aegis, "AppealWindowOpen")
    })
  })
})
