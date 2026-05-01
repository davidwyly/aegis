/**
 * Skip the commit window on the local hardhat node so the contract accepts
 * a reveal. Uses the standard `evm_increaseTime` + `evm_mine` JSON-RPC
 * helpers exposed by hardhat.
 */
export async function advanceTime(rpcUrl: string, seconds: number): Promise<void> {
  const body = (method: string, params: unknown[]) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body("evm_increaseTime", [seconds]),
  })
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body("evm_mine", []),
  })
}
