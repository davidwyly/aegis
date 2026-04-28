import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

/**
 * Deploy a VaultraAdapter pointing at a deployed Aegis and a deployed
 * VaultraEscrow. After deploy, the Vaultra owner must call
 * `updateEclipseDAO(adapter)` so new escrows default arbiter to the adapter.
 *
 *   pnpm -C blockchain hardhat ignition deploy ignition/modules/VaultraAdapter.ts \
 *     --network baseSepolia \
 *     --parameters '{"VaultraAdapter": {"aegis": "0x…", "vaultra": "0x…"}}'
 */
export default buildModule("VaultraAdapter", (m) => {
  const aegis = m.getParameter<string>("aegis")
  const vaultra = m.getParameter<string>("vaultra")

  const adapter = m.contract("VaultraAdapter", [aegis, vaultra])
  return { adapter }
})
