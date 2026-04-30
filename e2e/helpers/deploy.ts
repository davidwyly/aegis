import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseUnits,
  keccak256,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem"
import { hardhat } from "viem/chains"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"

import { aegisAbi } from "@/lib/abi/aegis"

/**
 * Hardhat's deterministic mnemonic produces the same 20 accounts every run.
 * We reserve the first 6 by role (governance, treasury, partyA, partyB,
 * arbiter0..2) and let the rest stay free for ad-hoc tests.
 *
 * Source: https://hardhat.org/hardhat-network/docs/reference#accounts
 */
/**
 * Look up the hardhat private key for a given account address. Tests need
 * this when the fixture reports "the drawn arbiter is X" — we have to be
 * able to sign on its behalf without re-running the deploy.
 */
export function privateKeyFor(address: Address): Hex {
  const lower = address.toLowerCase()
  for (const pk of HARDHAT_PRIVATE_KEYS) {
    if (privateKeyToAccount(pk).address.toLowerCase() === lower) return pk
  }
  throw new Error(`No hardhat private key matches ${address}`)
}

export const HARDHAT_PRIVATE_KEYS: readonly Hex[] = [
  // governance (signer 0)
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  // treasury (signer 1)
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  // partyA (signer 2)
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  // partyB (signer 3)
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  // arbiter0 (signer 4)
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  // arbiter1 (signer 5)
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  // arbiter2 (signer 6)
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
] as const

export interface DeployedFixture {
  rpcUrl: string
  chainId: number
  aegis: Address
  escrow: Address // MockArbitrableEscrow (Aegis sees this as the escrow)
  elcp: Address // stake token
  usdc: Address // case fee token
  coordinator: Address // MockVRFCoordinator
  governance: Address
  treasury: Address
  partyA: Address
  partyB: Address
  arbiters: Address[]
  // Test artifact: the seeded case the spec drives.
  seededCase: {
    aegisCaseId: Hex // Aegis-side caseId
    escrowCaseId: Hex // adapter/escrow-side caseId
    drawnArbiter: Address // which arbiter the VRF random word seated
    feeAmount: string // wei string for JSON-portability
    amount: string
  }
}

const HARDHAT_RPC = "http://127.0.0.1:8545"
const STAKE_REQ = parseEther("100")

interface Artifact {
  abi: unknown[]
  bytecode: Hex
}

function loadArtifact(relPath: string): Artifact {
  const path = resolve(process.cwd(), `blockchain/artifacts/contracts/${relPath}`)
  const json = JSON.parse(readFileSync(path, "utf-8"))
  return { abi: json.abi, bytecode: json.bytecode as Hex }
}

/**
 * Deploys ELCP, USDC, MockVRFCoordinator, Aegis, MockArbitrableEscrow, then
 * registers + stakes 3 arbiters and seeds one open case. Drives mock VRF so
 * an arbiter is seated synchronously. Returns everything tests need.
 */
export async function deployFixture(rpcUrl = HARDHAT_RPC): Promise<DeployedFixture> {
  const accounts = HARDHAT_PRIVATE_KEYS.map((pk) => privateKeyToAccount(pk))
  const [governance, treasury, partyA, partyB, ...arbiters] = accounts

  const publicClient = createPublicClient({ chain: hardhat, transport: http(rpcUrl) })

  // Sanity: hardhat node reachable.
  await publicClient.getChainId().catch(() => {
    throw new Error(
      `Could not reach hardhat node at ${rpcUrl}. Run \`pnpm contracts:node\` in another terminal first.`,
    )
  })

  const erc20 = loadArtifact("mocks/MockERC20.sol/MockERC20.json")
  const coord = loadArtifact("mocks/MockVRFCoordinator.sol/MockVRFCoordinator.json")
  const escrowArt = loadArtifact("mocks/MockArbitrableEscrow.sol/MockArbitrableEscrow.json")
  const aegisArt = loadArtifact("Aegis.sol/Aegis.json")

  const elcpAddr = await deploy(publicClient, governance, erc20, ["Eclipse", "ELCP", 18])
  const usdcAddr = await deploy(publicClient, governance, erc20, ["USD Coin", "USDC", 6])
  const coordinatorAddr = await deploy(publicClient, governance, coord, [])

  const aegisAddr = await deploy(publicClient, governance, aegisArt, [
    governance.address,
    elcpAddr,
    coordinatorAddr,
    {
      keyHash: ("0x" + "00".repeat(31) + "01") as Hex,
      subscriptionId: 1n,
      requestConfirmations: 3,
      callbackGasLimit: 500_000,
    },
    {
      commitWindow: BigInt(60 * 60 * 24),
      revealWindow: BigInt(60 * 60 * 24),
      graceWindow: BigInt(60 * 60 * 12),
      appealWindow: BigInt(60 * 60 * 24 * 7),
      repeatArbiterCooldown: BigInt(60 * 60 * 24 * 90),
      stakeRequirement: STAKE_REQ,
      appealFeeBps: 250,
      perArbiterFeeBps: 250,
      treasury: treasury.address,
    },
  ])

  const escrowAddr = await deploy(publicClient, governance, escrowArt, [aegisAddr])

  // Mint ELCP + register/stake all 3 arbiters.
  for (const a of arbiters) {
    await call(publicClient, governance, elcpAddr, erc20.abi, "mint", [a.address, parseEther("10000")])
    await call(publicClient, a, elcpAddr, erc20.abi, "approve", [aegisAddr, 2n ** 256n - 1n])
    await call(publicClient, governance, aegisAddr, aegisArt.abi, "registerArbiter", [a.address, zeroHash])
    await call(publicClient, a, aegisAddr, aegisArt.abi, "stake", [STAKE_REQ])
  }

  // Seed one open case.
  const escrowCaseId = keccak256(toHex("aegis-e2e-case-1"))
  const amount = parseUnits("1000", 6)
  const fee = parseUnits("50", 6)
  await call(publicClient, governance, escrowAddr, escrowArt.abi, "setCase", [
    escrowCaseId,
    partyA.address,
    partyB.address,
    usdcAddr,
    amount,
    fee,
  ])
  await call(publicClient, governance, usdcAddr, erc20.abi, "mint", [escrowAddr, fee])

  const openHash = await call(publicClient, governance, aegisAddr, aegisArt.abi, "openDispute", [
    escrowAddr,
    escrowCaseId,
  ])
  const openReceipt = await publicClient.getTransactionReceipt({ hash: openHash })

  // Pull CaseRequested out of the receipt to find vrfRequestId + caseId.
  const requestedTopic = keccak256(
    toHex("CaseRequested(bytes32,address,bytes32,address,address,address,uint256,uint256)"),
  )
  const requestedLog = openReceipt.logs.find((l) => l.topics[0] === requestedTopic)
  if (!requestedLog) throw new Error("CaseRequested not emitted")
  const aegisCaseId = requestedLog.topics[1] as Hex
  const requestId = BigInt(
    "0x" + requestedLog.data.slice(-64), // last 32 bytes of data
  )

  // Drive mock VRF. randomWord choice is arbitrary; pick one that lands on
  // arbiter index in {0,1,2} and write down which one was actually seated.
  await call(publicClient, governance, coordinatorAddr, coord.abi, "fulfillWithSingleWord", [
    requestId,
    0xdeadbeefn,
  ])

  const caseView = (await publicClient.readContract({
    address: aegisAddr,
    abi: aegisAbi,
    functionName: "getCase",
    args: [aegisCaseId],
  })) as { originalArbiter: Address }
  const drawnArbiter = caseView.originalArbiter

  return {
    rpcUrl,
    chainId: hardhat.id,
    aegis: aegisAddr,
    escrow: escrowAddr,
    elcp: elcpAddr,
    usdc: usdcAddr,
    coordinator: coordinatorAddr,
    governance: governance.address,
    treasury: treasury.address,
    partyA: partyA.address,
    partyB: partyB.address,
    arbiters: arbiters.map((a) => a.address),
    seededCase: {
      aegisCaseId,
      escrowCaseId,
      drawnArbiter,
      feeAmount: fee.toString(),
      amount: amount.toString(),
    },
  }
}

// ─── tiny helpers ──────────────────────────────────────────

type PublicClient = ReturnType<typeof createPublicClient>

async function deploy(
  publicClient: PublicClient,
  account: PrivateKeyAccount,
  art: Artifact,
  args: unknown[],
): Promise<Address> {
  const wallet = createWalletClient({ account, chain: hardhat, transport: http(publicClient.transport.url) })
  const hash = await wallet.deployContract({
    abi: art.abi,
    bytecode: art.bytecode,
    args,
  } as never)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error("deploy: no contractAddress on receipt")
  return receipt.contractAddress
}

async function call(
  publicClient: PublicClient,
  account: PrivateKeyAccount,
  to: Address,
  abi: unknown[],
  functionName: string,
  args: unknown[],
): Promise<Hex> {
  const wallet = createWalletClient({ account, chain: hardhat, transport: http(publicClient.transport.url) })
  const hash = await wallet.writeContract({
    address: to,
    abi: abi as never,
    functionName,
    args,
  } as never)
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}
