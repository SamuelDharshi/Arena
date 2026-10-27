import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, type Address, type Hex } from "viem";

/** Allowlist tree compatible with contracts/src/libs/MerkleLib.sol (StandardMerkleTree, ["address"]). */
export class Allowlist {
  readonly tree: StandardMerkleTree<[string]>;
  readonly addresses: Address[];

  constructor(addresses: string[]) {
    if (addresses.length === 0) throw new Error("allowlist must not be empty");
    this.addresses = [...new Set(addresses.map((a) => getAddress(a)))];
    this.tree = StandardMerkleTree.of<[string]>(
      this.addresses.map((a) => [a as string]),
      ["address"],
    );
  }

  get root(): Hex {
    return this.tree.root as Hex;
  }

  has(addr: string): boolean {
    try {
      const a = getAddress(addr);
      return this.addresses.includes(a);
    } catch {
      return false;
    }
  }

  /** Proof for an allowlisted address, or [] if not allowlisted (contract then treats it as non-allowlisted). */
  proof(addr: string): Hex[] {
    if (!this.has(addr)) return [];
    const a = getAddress(addr);
    for (const [i, v] of this.tree.entries()) {
      if (v[0] === a) return this.tree.getProof(i) as Hex[];
    }
    return [];
  }
}
