import { ethers } from "hardhat"

/**
 * One-shot local-dev deploy. Targets a running hardhat node via:
 *
 *   pnpm -C blockchain hardhat run scripts/deploy-local.ts --network localhost
 *
 * Sets up: ELCP + USDC mocks, Aegis (governance = signer0, treasury = signer1),
 * a MockArbitrableEscrow wired to Aegis, three registered+staked arbiters,
 * and a seeded test case so the public ledger isn't empty in dev.
 *
 * Prints env-var lines at the end so you can paste them into `.env.local`.
 */
async function main() {
  const [governance, treasury, partyA, partyB, ...rest] = await ethers.getSigners()
  const arbiters = rest.slice(0, 3)

  const MockERC20 = await ethers.getContractFactory("MockERC20")
  const elcp = await MockERC20.deploy("Eclipse", "ELCP", 18)
  await elcp.waitForDeployment()
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6)
  await usdc.waitForDeployment()

  const Coord = await ethers.getContractFactory("MockVRFCoordinator")
  const coordinator = await Coord.deploy()
  await coordinator.waitForDeployment()

  const STAKE_REQ = ethers.parseEther("100")
  const Aegis = await ethers.getContractFactory("Aegis")
  const aegis = await Aegis.deploy(
    governance.address,
    await elcp.getAddress(),
    await coordinator.getAddress(),
    {
      keyHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      subscriptionId: 1n,
      requestConfirmations: 3,
      callbackGasLimit: 500_000,
    },
    {
      panelSize: 3,
      voteWindow: 60 * 60 * 24,
      revealWindow: 60 * 60 * 24,
      graceWindow: 60 * 60 * 12,
      stakeRequirement: STAKE_REQ,
      panelFeeBps: 8000,
      treasury: treasury.address,
    }
  )
  await aegis.waitForDeployment()

  const Mock = await ethers.getContractFactory("MockArbitrableEscrow")
  const mock = await Mock.deploy(await aegis.getAddress())
  await mock.waitForDeployment()

  // Register + stake 3 arbiters.
  for (const a of arbiters) {
    await elcp.mint(a.address, ethers.parseEther("10000"))
    await elcp.connect(a).approve(await aegis.getAddress(), ethers.MaxUint256)
    await aegis.connect(governance).registerArbiter(a.address, ethers.ZeroHash)
    await aegis.connect(a).stake(STAKE_REQ)
  }

  // Seed a sample dispute so /cases isn't empty.
  const caseKey = ethers.keccak256(ethers.toUtf8Bytes("dev-seed-case-1"))
  const amount = ethers.parseUnits("1000", 6)
  const fee = ethers.parseUnits("50", 6)
  await mock.setCase(
    caseKey,
    partyA.address,
    partyB.address,
    await usdc.getAddress(),
    amount,
    fee
  )
  // Pre-fund the mock with the fee so applyArbitration can pay Aegis.
  await usdc.mint(await mock.getAddress(), fee)
  const openTx = await aegis.openDispute(await mock.getAddress(), caseKey)
  const openReceipt = await openTx.wait()
  // Drive the mock VRF fulfillment so the panel is seated immediately
  // (no real Chainlink subscription on a local hardhat node).
  const requested = openReceipt!.logs
    .map((l) => {
      try {
        return aegis.interface.parseLog(l as any)
      } catch {
        return null
      }
    })
    .find((e) => e?.name === "CaseRequested")
  if (requested) {
    const requestId = requested.args.vrfRequestId as bigint
    await coordinator.fulfillWithSingleWord(requestId, 0xdeadbeefn)
  }

  const aegisAddr = await aegis.getAddress()
  const mockAddr = await mock.getAddress()
  const elcpAddr = await elcp.getAddress()
  const usdcAddr = await usdc.getAddress()

  console.log("\n# ──────────────────────────────────────────────")
  console.log("# Aegis local-dev deploy complete. Paste into .env.local:")
  console.log("# ──────────────────────────────────────────────")
  console.log(`NEXT_PUBLIC_AEGIS_HARDHAT=${aegisAddr}`)
  console.log(`NEXT_PUBLIC_VAULTRA_ADAPTER_HARDHAT=${mockAddr}  # mock; for dev only`)
  console.log(`NEXT_PUBLIC_ELCP_HARDHAT=${elcpAddr}`)
  console.log(`NEXT_PUBLIC_USDC_HARDHAT=${usdcAddr}`)
  console.log(`# VRF coordinator (mock): ${await coordinator.getAddress()}`)
  console.log()
  console.log("# Test parties:")
  console.log(`#   governance: ${governance.address}`)
  console.log(`#   treasury:   ${treasury.address}`)
  console.log(`#   partyA:     ${partyA.address}`)
  console.log(`#   partyB:     ${partyB.address}`)
  for (let i = 0; i < arbiters.length; i++) {
    console.log(`#   arbiter ${i}:  ${arbiters[i].address}`)
  }
  console.log("# ──────────────────────────────────────────────\n")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
