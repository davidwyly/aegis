// AUTO-GENERATED from blockchain/artifacts/contracts/Aegis.sol/Aegis.json. Do not hand-edit.
export const aegisAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "governance",
        "type": "address"
      },
      {
        "internalType": "contract IERC20",
        "name": "_stakeToken",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_vrfCoordinator",
        "type": "address"
      },
      {
        "components": [
          {
            "internalType": "bytes32",
            "name": "keyHash",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "subscriptionId",
            "type": "uint64"
          },
          {
            "internalType": "uint16",
            "name": "requestConfirmations",
            "type": "uint16"
          },
          {
            "internalType": "uint32",
            "name": "callbackGasLimit",
            "type": "uint32"
          }
        ],
        "internalType": "struct Aegis.VrfConfig",
        "name": "_vrfConfig",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "uint64",
            "name": "commitWindow",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "revealWindow",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "graceWindow",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "appealWindow",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "repeatArbiterCooldown",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "stakeRequirement",
            "type": "uint256"
          },
          {
            "internalType": "uint16",
            "name": "appealFeeBps",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "perArbiterFeeBps",
            "type": "uint16"
          },
          {
            "internalType": "address",
            "name": "treasury",
            "type": "address"
          }
        ],
        "internalType": "struct Aegis.Policy",
        "name": "_policy",
        "type": "tuple"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AccessControlBadConfirmation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "neededRole",
        "type": "bytes32"
      }
    ],
    "name": "AccessControlUnauthorizedAccount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadyActive",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadyCommitted",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadyRevealed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AmountTooLarge",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AppealAlreadyExists",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AppealCommitClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AppealRevealClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AppealWindowClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AppealWindowOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AppealantNotParty",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CannotRecuseAfterCommit",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseAlreadyFinalized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseAlreadyLive",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseExists",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseNotAppealable",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseNotAwaitingPanel",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseNotFound",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseNotInVotingState",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseNotOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseNotRevealing",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseNotStuck",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CaseNotYetStuck",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CasePaused",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CommitMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CommitWindowClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CommitWindowOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "EscrowReportsInactive",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FullWinnerCannotAppeal",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "GraceWindowOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientStake",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientTreasury",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPercentage",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPolicy",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LockUnderflow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoCommit",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotActive",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAppealPanelist",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAssignedArbiter",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotEnoughArbiters",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotImplemented",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotPanelist",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NothingToClaim",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OnlyVRFCoordinator",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReentrancyGuardReentrantCall",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RevealWindowClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RevealWindowOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RosterFull",
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
    "name": "StakeLocked",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TokenMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnknownVrfRequest",
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
        "internalType": "address",
        "name": "appellant",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "feeAmount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "feeToken",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "vrfRequestId",
        "type": "uint256"
      }
    ],
    "name": "AppealRequested",
    "type": "event"
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
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      }
    ],
    "name": "ArbiterDrawn",
    "type": "event"
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
        "internalType": "address",
        "name": "previousArbiter",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "replacement",
        "type": "address"
      }
    ],
    "name": "ArbiterRedrawn",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "credentialCID",
        "type": "bytes32"
      }
    ],
    "name": "ArbiterRegistered",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "slashedToTreasury",
        "type": "uint256"
      }
    ],
    "name": "ArbiterRevoked",
    "type": "event"
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
        "indexed": false,
        "internalType": "uint256",
        "name": "appealFeeRefunded",
        "type": "uint256"
      }
    ],
    "name": "CaseCanceled",
    "type": "event"
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
        "indexed": false,
        "internalType": "uint16",
        "name": "fallbackPercentage",
        "type": "uint16"
      }
    ],
    "name": "CaseDefaultResolved",
    "type": "event"
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
        "internalType": "address",
        "name": "escrow",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "escrowCaseId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "partyA",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "partyB",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "feeToken",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "CaseOpened",
    "type": "event"
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
        "internalType": "address",
        "name": "escrow",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "escrowCaseId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "partyA",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "partyB",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "feeToken",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "vrfRequestId",
        "type": "uint256"
      }
    ],
    "name": "CaseRequested",
    "type": "event"
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
        "indexed": false,
        "internalType": "uint16",
        "name": "finalPercentage",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "finalDigest",
        "type": "bytes32"
      }
    ],
    "name": "CaseResolved",
    "type": "event"
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
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "commitHash",
        "type": "bytes32"
      }
    ],
    "name": "Committed",
    "type": "event"
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
        "indexed": false,
        "internalType": "address",
        "name": "feeToken",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "totalReceived",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "arbiterTotal",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "partyRebateTotal",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "treasuryAmount",
        "type": "uint256"
      }
    ],
    "name": "FeesAccrued",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "FeesClaimed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bool",
        "name": "paused",
        "type": "bool"
      }
    ],
    "name": "NewCasesPaused",
    "type": "event"
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
        "internalType": "address",
        "name": "party",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "PartyRebated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "commitWindow",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "revealWindow",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "graceWindow",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "appealWindow",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "repeatArbiterCooldown",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "stakeRequirement",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "appealFeeBps",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "perArbiterFeeBps",
        "type": "uint16"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "treasury",
        "type": "address"
      }
    ],
    "name": "PolicyUpdated",
    "type": "event"
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
        "internalType": "address",
        "name": "recused",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "replacement",
        "type": "address"
      }
    ],
    "name": "Recused",
    "type": "event"
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
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "partyAPercentage",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "rationaleDigest",
        "type": "bytes32"
      }
    ],
    "name": "Revealed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "role",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "previousAdminRole",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "newAdminRole",
        "type": "bytes32"
      }
    ],
    "name": "RoleAdminChanged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "role",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "sender",
        "type": "address"
      }
    ],
    "name": "RoleGranted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "role",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "sender",
        "type": "address"
      }
    ],
    "name": "RoleRevoked",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "caseId",
        "type": "bytes32"
      }
    ],
    "name": "Slashed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "newTotal",
        "type": "uint256"
      }
    ],
    "name": "StakeIncreased",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "newTotal",
        "type": "uint256"
      }
    ],
    "name": "StakeWithdrawn",
    "type": "event"
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
        "indexed": false,
        "internalType": "uint8",
        "name": "round",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "slashedTotal",
        "type": "uint256"
      }
    ],
    "name": "Stalled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "TreasuryWithdrawn",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "keyHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "subscriptionId",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "confirmations",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "callbackGasLimit",
        "type": "uint32"
      }
    ],
    "name": "VrfConfigUpdated",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "BPS_DENOMINATOR",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "DEFAULT_ADMIN_ROLE",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "DEFAULT_PERCENTAGE",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "GOVERNANCE_ROLE",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_APPEAL_FEE_BPS",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_APPEAL_WINDOW",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_ARBITER_ROSTER",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_COMMIT_REVEAL_WINDOW",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_PER_ARBITER_FEE_BPS",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_REPEAT_COOLDOWN",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MIN_APPEAL_WINDOW",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MIN_COMMIT_REVEAL_WINDOW",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "STUCK_CASE_GRACE",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "arbiters",
    "outputs": [
      {
        "internalType": "bool",
        "name": "active",
        "type": "bool"
      },
      {
        "internalType": "uint96",
        "name": "stakedAmount",
        "type": "uint96"
      },
      {
        "internalType": "uint64",
        "name": "listIndex",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "caseCount",
        "type": "uint64"
      },
      {
        "internalType": "bytes32",
        "name": "credentialCID",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "claim",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "claimable",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
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
        "internalType": "bytes32",
        "name": "commitHash",
        "type": "bytes32"
      }
    ],
    "name": "commitVote",
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
    "name": "finalize",
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
    "name": "forceCancelStuck",
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
      },
      {
        "internalType": "uint8",
        "name": "idx",
        "type": "uint8"
      }
    ],
    "name": "getAppealSlot",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "arbiter",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "commitHash",
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
          },
          {
            "internalType": "bool",
            "name": "revealed",
            "type": "bool"
          }
        ],
        "internalType": "struct Aegis.AppealSlot",
        "name": "",
        "type": "tuple"
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
    "name": "getCase",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "escrow",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "escrowCaseId",
            "type": "bytes32"
          },
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
            "internalType": "enum Aegis.CaseState",
            "name": "state",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "stallRound",
            "type": "uint8"
          },
          {
            "internalType": "uint64",
            "name": "openedAt",
            "type": "uint64"
          },
          {
            "internalType": "address",
            "name": "originalArbiter",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "originalCommitHash",
            "type": "bytes32"
          },
          {
            "internalType": "uint16",
            "name": "originalPercentage",
            "type": "uint16"
          },
          {
            "internalType": "bytes32",
            "name": "originalDigest",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "originalCommitDeadline",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "originalRevealDeadline",
            "type": "uint64"
          },
          {
            "internalType": "bool",
            "name": "originalRevealed",
            "type": "bool"
          },
          {
            "internalType": "address",
            "name": "appellant",
            "type": "address"
          },
          {
            "internalType": "uint64",
            "name": "appealDeadline",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "appealCommitDeadline",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "appealRevealDeadline",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "appealFeeAmount",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "escrowFeeReceived",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "feesDistributed",
            "type": "bool"
          }
        ],
        "internalType": "struct Aegis.CaseView",
        "name": "",
        "type": "tuple"
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
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      }
    ],
    "name": "getCommit",
    "outputs": [
      {
        "components": [
          {
            "internalType": "bytes32",
            "name": "hash",
            "type": "bytes32"
          },
          {
            "internalType": "bool",
            "name": "revealed",
            "type": "bool"
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
        "internalType": "struct Aegis.CommitView",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "role",
        "type": "bytes32"
      }
    ],
    "name": "getRoleAdmin",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "role",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "grantRole",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "role",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "hasRole",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
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
        "name": "salt",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "rationaleDigest",
        "type": "bytes32"
      }
    ],
    "name": "hashVote",
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
        "name": "",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "lastArbitratedAt",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "liveCaseFor",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "lockedStake",
    "outputs": [
      {
        "internalType": "uint96",
        "name": "",
        "type": "uint96"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "newCasesPaused",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "contract IArbitrableEscrow",
        "name": "escrow",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "escrowCaseId",
        "type": "bytes32"
      }
    ],
    "name": "openDispute",
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
    "name": "policy",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "commitWindow",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "revealWindow",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "graceWindow",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "appealWindow",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "repeatArbiterCooldown",
        "type": "uint64"
      },
      {
        "internalType": "uint256",
        "name": "stakeRequirement",
        "type": "uint256"
      },
      {
        "internalType": "uint16",
        "name": "appealFeeBps",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "perArbiterFeeBps",
        "type": "uint16"
      },
      {
        "internalType": "address",
        "name": "treasury",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "requestId",
        "type": "uint256"
      },
      {
        "internalType": "uint256[]",
        "name": "randomWords",
        "type": "uint256[]"
      }
    ],
    "name": "rawFulfillRandomWords",
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
    "name": "recuse",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "credentialCID",
        "type": "bytes32"
      }
    ],
    "name": "registerArbiter",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "role",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "callerConfirmation",
        "type": "address"
      }
    ],
    "name": "renounceRole",
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
    "name": "requestAppeal",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "requestId",
        "type": "uint256"
      }
    ],
    "name": "requestToCase",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "caseId",
        "type": "bytes32"
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
        "name": "salt",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "rationaleDigest",
        "type": "bytes32"
      }
    ],
    "name": "revealVote",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "arbiter",
        "type": "address"
      }
    ],
    "name": "revokeArbiter",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "role",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "revokeRole",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bool",
        "name": "paused",
        "type": "bool"
      }
    ],
    "name": "setNewCasesPaused",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "uint64",
            "name": "commitWindow",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "revealWindow",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "graceWindow",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "appealWindow",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "repeatArbiterCooldown",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "stakeRequirement",
            "type": "uint256"
          },
          {
            "internalType": "uint16",
            "name": "appealFeeBps",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "perArbiterFeeBps",
            "type": "uint16"
          },
          {
            "internalType": "address",
            "name": "treasury",
            "type": "address"
          }
        ],
        "internalType": "struct Aegis.Policy",
        "name": "p",
        "type": "tuple"
      }
    ],
    "name": "setPolicy",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "bytes32",
            "name": "keyHash",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "subscriptionId",
            "type": "uint64"
          },
          {
            "internalType": "uint16",
            "name": "requestConfirmations",
            "type": "uint16"
          },
          {
            "internalType": "uint32",
            "name": "callbackGasLimit",
            "type": "uint32"
          }
        ],
        "internalType": "struct Aegis.VrfConfig",
        "name": "cfg",
        "type": "tuple"
      }
    ],
    "name": "setVrfConfig",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "stake",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "stakeToken",
    "outputs": [
      {
        "internalType": "contract IERC20",
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
        "internalType": "bytes4",
        "name": "interfaceId",
        "type": "bytes4"
      }
    ],
    "name": "supportsInterface",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "treasuryAccrued",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "unstake",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "vrfConfig",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "keyHash",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "subscriptionId",
        "type": "uint64"
      },
      {
        "internalType": "uint16",
        "name": "requestConfirmations",
        "type": "uint16"
      },
      {
        "internalType": "uint32",
        "name": "callbackGasLimit",
        "type": "uint32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "vrfCoordinator",
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
        "internalType": "contract IERC20",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "withdrawTreasury",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const
