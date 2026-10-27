// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Allowlist membership using the OpenZeppelin StandardMerkleTree leaf encoding for ["address"].
library MerkleLib {
    function leaf(address a) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a))));
    }

    function verify(bytes32 root, address a, bytes32[] calldata proof) internal pure returns (bool) {
        if (root == bytes32(0)) return false;
        return MerkleProof.verifyCalldata(proof, root, leaf(a));
    }
}
