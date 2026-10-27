import type { Address, Hex } from "viem";

export const intentTypes = {
  Intent: [
    { name: "agentId", type: "uint256" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint128" },
    { name: "category", type: "bytes32" },
    { name: "ref", type: "bytes32" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const attestationTypes = {
  Attestation: [
    { name: "sid", type: "uint256" },
    { name: "msgCount", type: "uint32" },
    { name: "transcriptRoot", type: "bytes32" },
    { name: "endedAt", type: "uint64" },
  ],
} as const;

export interface Intent {
  agentId: bigint;
  to: Address;
  amount: bigint;
  category: Hex;
  ref: Hex;
  nonce: bigint;
  deadline: bigint;
}

export interface Attestation {
  sid: bigint;
  msgCount: number;
  transcriptRoot: Hex;
  endedAt: bigint;
}

export function policyWalletDomain(chainId: number, vault: Address) {
  return { name: "PolicyWallet", version: "1", chainId, verifyingContract: vault } as const;
}

export function arenaDomain(chainId: number, arena: Address) {
  return { name: "ArenaCore", version: "1", chainId, verifyingContract: arena } as const;
}
