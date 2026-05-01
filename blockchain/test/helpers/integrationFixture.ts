import { ethers } from "hardhat"
import type {
  Aegis,
  VaultraAdapter,
  VaultraEscrow,
  MockUSDC,
  MockERC20,
  MockVRFCoordinator,
} from "../../typechain-types"
import type { Signer } from "ethers"

// ── Aegis VRF / policy constants ─────────────────────────────────────
export const VRF_KEY_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000001"
export const VRF_SUB_ID = 1n
export const VRF_CONFIRMATIONS = 3
export const VRF_CALLBACK_GAS = 500_000

export const COMMIT_WINDOW = 60 * 60 * 24 // 24h, also the "VOTE_WINDOW" alias below
export const VOTE_WINDOW = COMMIT_WINDOW
export const REVEAL_WINDOW = 60 * 60 * 24
export const GRACE_WINDOW = 60 * 60 * 12
export const APPEAL_WINDOW = 60 * 60 * 24 * 7
export const REPEAT_ARBITER_COOLDOWN = 60 * 60 * 24 * 90
export const STAKE_REQ = ethers.parseEther("100")
export const APPEAL_FEE_BPS = 250
export const PER_ARBITER_FEE_BPS = 250

// ── VaultraEscrow numeric encodings ──────────────────────────────────
export const VAULTRA_STATUS_ACTIVE = 0n
export const VAULTRA_STATUS_COMPLETED = 1n
export const VAULTRA_STATUS_DISPUTED = 2n

// Mirror Vaultra's fee math (lines 14-27 of VaultraEscrow.sol).
export const VAULTRA_FEE_BPS = 25n
export const VAULTRA_FEE_DENOM = 1000n

export const usdc = (n: string) => ethers.parseUnits(n, 6)
export const platformFee = (amount: bigint) =>
  (amount * VAULTRA_FEE_BPS) / VAULTRA_FEE_DENOM
export const disputeCollateral = (amount: bigint) =>
  (amount * VAULTRA_FEE_BPS) / VAULTRA_FEE_DENOM
export const totalUpfront = (amount: bigint) =>
  amount + platformFee(amount) + disputeCollateral(amount)

export const PROPOSAL_DIGEST = ethers.keccak256(
  ethers.toUtf8Bytes("integration-proposal"),
)

export interface IntegrationCtx {
  aegis: Aegis
  coordinator: MockVRFCoordinator
  adapter: VaultraAdapter
  vaultra: VaultraEscrow
  usdcToken: MockUSDC
  elcpToken: MockERC20
  governance: Signer
  treasury: Signer
  vaultraOwner: Signer
  client: Signer
  worker: Signer
  arbiterSigners: Signer[]
}

/**
 * Deploys the full Aegis + Vaultra + adapter stack on whichever network
 * hardhat is currently pointed at. Used by both the local-network
 * integration test and the Base Sepolia fork variant. Caller decides
 * whether to wrap this in `loadFixture` (local) or run it once after a
 * `hardhat_reset` to a fork (fork test).
 *
 * Uses MockUSDC + MockVRFCoordinator on the fork rather than real Base
 * Sepolia USDC / Chainlink VRF. Real-USDC parity needs whale
 * impersonation; real VRF needs a funded subscription. The fork still
 * gives real chain id (84532), real timestamps, and end-to-end deploy
 * on production EVM behavior.
 */
export async function deployIntegrationStack(): Promise<IntegrationCtx> {
  const signers = await ethers.getSigners()
  const [governance, treasury, vaultraOwner, client, worker, ...rest] = signers
  const arbiterSigners = rest.slice(0, 6)

  const USDC = await ethers.getContractFactory("MockUSDC")
  const usdcToken = (await USDC.deploy()) as unknown as MockUSDC
  await usdcToken.waitForDeployment()

  const ELCP = await ethers.getContractFactory("MockERC20")
  const elcpToken = (await ELCP.deploy(
    "Eclipse",
    "ELCP",
    18,
  )) as unknown as MockERC20
  await elcpToken.waitForDeployment()

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
      commitWindow: COMMIT_WINDOW,
      revealWindow: REVEAL_WINDOW,
      graceWindow: GRACE_WINDOW,
      appealWindow: APPEAL_WINDOW,
      repeatArbiterCooldown: REPEAT_ARBITER_COOLDOWN,
      stakeRequirement: STAKE_REQ,
      appealFeeBps: APPEAL_FEE_BPS,
      perArbiterFeeBps: PER_ARBITER_FEE_BPS,
      treasury: treasury.address,
    },
  )) as unknown as Aegis
  await aegis.waitForDeployment()

  // Deploy Vaultra with a placeholder eclipseDAO; rewire to the adapter
  // once it exists. (Adapter constructor needs Vaultra's address.)
  const Vaultra = await ethers.getContractFactory("VaultraEscrow")
  const placeholderDAO = vaultraOwner.address
  const vaultra = (await Vaultra.deploy(
    await usdcToken.getAddress(),
    placeholderDAO,
    vaultraOwner.address,
  )) as unknown as VaultraEscrow
  await vaultra.waitForDeployment()

  const Adapter = await ethers.getContractFactory("VaultraAdapter")
  const adapter = (await Adapter.deploy(
    await aegis.getAddress(),
    await vaultra.getAddress(),
  )) as unknown as VaultraAdapter
  await adapter.waitForDeployment()

  await vaultra
    .connect(vaultraOwner)
    .updateEclipseDAO(await adapter.getAddress())

  // Roster: register + stake 6 arbiters so we have plenty for redraws /
  // cooldowns.
  for (const a of arbiterSigners) {
    await elcpToken.mint(await a.getAddress(), ethers.parseEther("10000"))
    await elcpToken
      .connect(a)
      .approve(await aegis.getAddress(), ethers.MaxUint256)
    await aegis
      .connect(governance)
      .registerArbiter(await a.getAddress(), ethers.ZeroHash)
    await aegis.connect(a).stake(STAKE_REQ)
  }

  await usdcToken.mint(await client.getAddress(), usdc("1000000"))

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

export async function createAndFundEscrow(
  vaultra: VaultraEscrow,
  usdcToken: MockUSDC,
  client: Signer,
  worker: Signer,
  amount: bigint,
): Promise<string> {
  const workerAddr = await worker.getAddress()
  await usdcToken
    .connect(client)
    .approve(await vaultra.getAddress(), totalUpfront(amount))
  const tx = await vaultra
    .connect(client)
    .createEscrow(
      "integration",
      "round-trip test",
      workerAddr,
      ethers.ZeroAddress, // arbiter = adapter via eclipseDAO default
      amount,
      PROPOSAL_DIGEST,
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
  return log!.args.escrowId as string
}
