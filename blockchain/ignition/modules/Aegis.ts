import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

/**
 * Deploy Aegis with constructor params populated from the ignition
 * parameter file. Example invocation:
 *
 *   cd blockchain && pnpm exec hardhat ignition deploy ignition/modules/Aegis.ts \
 *     --network baseSepolia \
 *     --parameters '{
 *       "Aegis": {
 *         "governance":         "0x...",
 *         "stakeToken":         "0x<elcp>",
 *         "treasury":           "0x...",
 *         "vrfCoordinator":     "0x<chainlink-coordinator-on-this-chain>",
 *         "vrfKeyHash":         "0x<gas-lane-key-hash>",
 *         "vrfSubscriptionId":  "12345"
 *       }
 *     }'
 */
export default buildModule("Aegis", (m) => {
  const governance = m.getParameter<string>("governance")
  const stakeToken = m.getParameter<string>("stakeToken")
  const treasury = m.getParameter<string>("treasury")

  // Chainlink VRF v2 — caller must supply the right values for the
  // target chain. For Base / Base Sepolia, see Chainlink docs.
  const vrfCoordinator = m.getParameter<string>("vrfCoordinator")
  const vrfKeyHash = m.getParameter<string>("vrfKeyHash")
  const vrfSubscriptionId = m.getParameter<bigint>("vrfSubscriptionId")
  const vrfConfirmations = m.getParameter<number>("vrfConfirmations", 3)
  const vrfCallbackGasLimit = m.getParameter<number>("vrfCallbackGasLimit", 500_000)

  // Defaults are sane v1 values; override per-network via `--parameters`.
  const panelSize = m.getParameter<number>("panelSize", 3)
  const voteWindow = m.getParameter<number>("voteWindow", 86_400) // 1 day
  const revealWindow = m.getParameter<number>("revealWindow", 86_400) // 1 day
  const graceWindow = m.getParameter<number>("graceWindow", 43_200) // 12 hours
  const stakeRequirement = m.getParameter<bigint>(
    "stakeRequirement",
    100_000_000000000000000000n, // 100 ELCP (18 decimals)
  )
  const panelFeeBps = m.getParameter<number>("panelFeeBps", 8000)

  const aegis = m.contract("Aegis", [
    governance,
    stakeToken,
    vrfCoordinator,
    {
      keyHash: vrfKeyHash,
      subscriptionId: vrfSubscriptionId,
      requestConfirmations: vrfConfirmations,
      callbackGasLimit: vrfCallbackGasLimit,
    },
    {
      panelSize,
      voteWindow,
      revealWindow,
      graceWindow,
      stakeRequirement,
      panelFeeBps,
      treasury,
    },
  ])

  return { aegis }
})
