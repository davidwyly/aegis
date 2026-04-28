/**
 * Hand-rolled Vaultra ABI subset — just enough for the keeper to subscribe to
 * dispute events. We don't import Vaultra's artifacts; if Vaultra evolves its
 * event signatures, update these to match.
 *
 * Source: /home/dwyly/code/vaultra/blockchain/contracts/VaultraEscrow.sol:102-118
 */
export const vaultraDisputeEventsAbi = [
  {
    type: "event",
    name: "DisputeRaised",
    inputs: [
      { name: "escrowId", type: "bytes32", indexed: true },
      { name: "milestoneIndex", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DisputeRaisedNoMilestone",
    inputs: [{ name: "escrowId", type: "bytes32", indexed: true }],
    anonymous: false,
  },
] as const
