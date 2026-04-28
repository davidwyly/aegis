// AUTO-GENERATED from blockchain/artifacts/contracts/interfaces/IArbitrableEscrow.sol/IArbitrableEscrow.json. Do not hand-edit.
export const arbitrableEscrowAbi = [
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "caseId",
        "type": "bytes32"
      },
      {
        "internalType": "uint16",
        "name": "partyAPercentage",
        "type": "uint16"
      },
      {
        "internalType": "bytes32",
        "name": "rationaleDigest",
        "type": "bytes32"
      }
    ],
    "name": "applyArbitration",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "caseId",
        "type": "bytes32"
      }
    ],
    "name": "getDisputeContext",
    "outputs": [
      {
        "internalType": "address",
        "name": "partyA",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "partyB",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "feeToken",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "active",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const
