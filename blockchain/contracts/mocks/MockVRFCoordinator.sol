// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVRFConsumerCallback {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/**
 * @title MockVRFCoordinator
 * @notice Hardhat-only mock that mimics Chainlink's VRFCoordinatorV2.
 *         `requestRandomWords` records the request and returns an id;
 *         tests then call `fulfillRandomWords(requestId, words)` to drive
 *         the consumer callback. Lets us exercise the async open flow
 *         deterministically without any actual oracle.
 */
contract MockVRFCoordinator {
    struct PendingRequest {
        address consumer;
        bool fulfilled;
    }

    uint256 public nextRequestId = 1;
    mapping(uint256 => PendingRequest) public requests;

    event RandomnessRequested(uint256 indexed requestId, address indexed consumer);
    event RandomnessFulfilled(uint256 indexed requestId);

    error UnknownRequest();
    error AlreadyFulfilled();

    function requestRandomWords(
        bytes32, /* keyHash */
        uint64, /* subId */
        uint16, /* minimumRequestConfirmations */
        uint32, /* callbackGasLimit */
        uint32 /* numWords */
    ) external returns (uint256 requestId) {
        requestId = nextRequestId++;
        requests[requestId] = PendingRequest({consumer: msg.sender, fulfilled: false});
        emit RandomnessRequested(requestId, msg.sender);
    }

    /**
     * @notice Drive a fulfilment from a test. The consumer must implement
     *         the standard VRFConsumerBaseV2 callback.
     */
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        PendingRequest storage r = requests[requestId];
        if (r.consumer == address(0)) revert UnknownRequest();
        if (r.fulfilled) revert AlreadyFulfilled();
        r.fulfilled = true;
        IVRFConsumerCallback(r.consumer).rawFulfillRandomWords(requestId, randomWords);
        emit RandomnessFulfilled(requestId);
    }

    /**
     * @notice Convenience for tests: fulfill with a single-word array
     *         derived from a uint256 the test cares about.
     */
    function fulfillWithSingleWord(uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        // re-enter via the public selector so the same locked-down access
        // path runs.
        this.fulfillRandomWords(requestId, words);
    }
}
