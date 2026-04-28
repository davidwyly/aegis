// AUTO-GENERATED from blockchain/artifacts/contracts/adapters/VaultraAdapter.sol/VaultraAdapter.json. Do not hand-edit.
export const vaultraAdapterAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_aegis",
        "type": "address"
      },
      {
        "internalType": "contract IVaultraEscrow",
        "name": "_vaultra",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AlreadyRegistered",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotArbiter",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotDisputed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OnlyAegis",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "SafeERC20FailedOperation",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnknownCase",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "caseId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "escrowId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "milestoneIndex",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "noMilestone",
        "type": "bool"
      }
    ],
    "name": "CaseRegistered",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "aegis",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
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
    "name": "caseInfo",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "escrowId",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "milestoneIndex",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "noMilestone",
        "type": "bool"
      },
      {
        "internalType": "bool",
        "name": "registered",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
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
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "escrowId",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "milestoneIndex",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "noMilestone",
        "type": "bool"
      }
    ],
    "name": "packCaseId",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "escrowId",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "milestoneIndex",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "noMilestone",
        "type": "bool"
      }
    ],
    "name": "registerCase",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "caseId",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "vaultra",
    "outputs": [
      {
        "internalType": "contract IVaultraEscrow",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const
