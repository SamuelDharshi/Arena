/**
 * Diagnose (and optionally repair) an Arc account that a below-floor transaction has wedged.
 *   pnpm arc:doctor 0xAddress                 # report only
 *   ARC_DOCTOR_KEY=0x… pnpm arc:doctor 0xAddress --fix   # replace the stuck nonce (account must be yours)
 * Background and evidence: docs/feedback-arc-circle.md
 */
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { diagnose, unwedge } from "../packages/shared/src/index";
import { chain, publicClient, rpcUrl } from "./lib";

async function main() {
  const address = process.argv[2] as `0x${string}` | undefined;
  if (!address?.startsWith("0x")) throw new Error("usage: pnpm arc:doctor 0xAddress [--fix]");
  const d = await diagnose(publicClient, address);
  console.log(`account        ${d.address}`);
  console.log(`mined nonce    ${d.confirmedNonce}`);
  console.log(`pending nonce  ${d.pendingNonce}`);
  console.log(`fee floor      ${Number(d.floor) / 1e9} gwei`);
  console.log(d.hasPendingTxs ? "⚠ the node holds unmined transactions for this account (a stuck one blocks all later ones)" : "✓ no pending transactions visible (a stuck tx can still hide; use --fix to be sure)");
  if (process.argv.includes("--fix")) {
    const key = process.env.ARC_DOCTOR_KEY as `0x${string}` | undefined;
    if (!key) throw new Error("--fix needs ARC_DOCTOR_KEY=<private key of the account>");
    const account = privateKeyToAccount(key);
    if (account.address.toLowerCase() !== address.toLowerCase()) throw new Error("ARC_DOCTOR_KEY does not match the address");
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
    const r = await unwedge(wallet, publicClient);
    console.log(`✓ replaced nonce ${r.nonce}: ${r.hash} (block ${r.receipt.blockNumber})`);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
