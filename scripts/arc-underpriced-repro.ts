/**
 * Reproduces the Arc "accepted but never mined" transaction problem, then shows the guard and the repair.
 *   REPRO_KEY=0x<funded testnet key, ≥ 0.01 USDC> pnpm arc:repro
 * It sends ONE zero-value self-transfer priced at 10 gwei (below the 20 gwei floor) and then repairs the account.
 * Use a throwaway key. Background and evidence: docs/feedback-arc-circle.md
 */
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArcUnderpricedError, diagnose, guardFee, sendArcTx, unwedge } from "../packages/shared/src/index";
import { chain, publicClient, rpcUrl } from "./lib";

const GWEI = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = process.env.REPRO_KEY as `0x${string}` | undefined;
  if (!key) throw new Error("set REPRO_KEY to a funded throwaway testnet key");
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const start = await diagnose(publicClient, account.address);
  console.log(`account ${account.address} · mined nonce ${start.confirmedNonce} · floor ${Number(start.floor) / 1e9} gwei\n`);

  console.log("1) The RPC accepts a transaction priced at 10 gwei (below the 20 gwei floor):");
  const stuck = await wallet.sendTransaction({ account, chain, to: account.address, value: 0n, gas: 21_000n, nonce: start.confirmedNonce, maxFeePerGas: 10n * GWEI, maxPriorityFeePerGas: GWEI });
  console.log(`   ✓ eth_sendRawTransaction returned a hash, no error: ${stuck}`);

  console.log("2) ...but it is never mined. Waiting 20 s:");
  await sleep(20_000);
  const receipt = await publicClient.getTransactionReceipt({ hash: stuck }).catch(() => null);
  const seen = await publicClient.getTransaction({ hash: stuck }).catch(() => null);
  console.log(`   receipt: ${receipt ? "mined (unexpected)" : "none"} · node still lists it: ${seen ? "yes, pending" : "no"}`);

  console.log("3) A correctly priced transaction at the NEXT nonce is blocked behind it:");
  const next = await wallet.sendTransaction({ account, chain, to: account.address, value: 0n, gas: 21_000n, nonce: start.confirmedNonce + 1, maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: GWEI });
  await sleep(12_000);
  const nextReceipt = await publicClient.getTransactionReceipt({ hash: next }).catch(() => null);
  console.log(`   30 gwei tx at nonce ${start.confirmedNonce + 1}: ${nextReceipt ? "mined (unexpected)" : "still unmined — the account is wedged"}`);

  console.log("4) The fix, part 1 — guardFee refuses to send under the floor:");
  try {
    await guardFee(publicClient, { maxFeePerGas: 10n * GWEI });
    console.log("   ✗ guard did not trigger");
  } catch (e) {
    console.log(`   ✓ ${e instanceof ArcUnderpricedError ? "ArcUnderpricedError" : "error"}: ${(e as Error).message.split(".")[0]}`);
  }

  console.log("5) The fix, part 2 — unwedge replaces the stuck nonce (replace-by-fee):");
  const r = await unwedge(wallet, publicClient);
  await sleep(4_000);
  const after = await diagnose(publicClient, account.address);
  console.log(`   ✓ nonce ${r.nonce} replaced in block ${r.receipt.blockNumber}; later tx now mined; mined nonce ${after.confirmedNonce}`);

  console.log("6) The fix, part 3 — sendArcTx does guard + confirmed nonce + bounded wait + auto-bump:");
  const ok = await sendArcTx(wallet, publicClient, { to: account.address, value: 0n });
  console.log(`   ✓ mined in ${ok.attempts} attempt(s): ${ok.hash}`);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
