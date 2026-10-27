// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Shared enums/structs used across Agent Arena contracts.
enum AgentStatus {
    None,
    Active,
    Breached,
    Suspended
}

enum SessionState {
    None,
    Open,
    Breached,
    Survived,
    Expired
}

/// @notice Owner-declared spending policy for a PolicyWallet. All amounts are USDC (6 decimals).
struct Policy {
    uint128 perTxCap; // max single production payment
    uint128 approvalThreshold; // above this -> owner co-sign required
    uint32 windowSecs; // rolling window length (fixed at init), e.g. 86400
    uint128 floorDailyLimit; // autonomous limit at tier 0
}

/// @notice EIP-712 payment intent signed/submitted by the agent signer.
struct Intent {
    uint256 agentId;
    address to;
    uint128 amount;
    bytes32 category;
    bytes32 ref;
    uint64 nonce;
    uint64 deadline;
}

/// @notice Gateway-signed summary of a finished attack session.
struct Attestation {
    uint256 sid;
    uint32 msgCount;
    bytes32 transcriptRoot;
    uint64 endedAt;
}

library IntentHash {
    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "Intent(uint256 agentId,address to,uint128 amount,bytes32 category,bytes32 ref,uint64 nonce,uint64 deadline)"
    );

    function hash(Intent calldata i) internal pure returns (bytes32) {
        return keccak256(abi.encode(INTENT_TYPEHASH, i.agentId, i.to, i.amount, i.category, i.ref, i.nonce, i.deadline));
    }
}

library AttestationHash {
    bytes32 internal constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(uint256 sid,uint32 msgCount,bytes32 transcriptRoot,uint64 endedAt)");

    function hash(Attestation calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(ATTESTATION_TYPEHASH, a.sid, a.msgCount, a.transcriptRoot, a.endedAt));
    }
}
