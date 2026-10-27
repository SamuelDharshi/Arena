/**
 * Proof that a Circle developer-controlled wallet can sign and submit a contract call on Arc testnet.
 * Funds the NAIVE00 Circle wallet with a little gas, then calls USDC.approve(vault, 0) through Circle's API.
 *   pnpm exec tsx scripts/circle-proof.ts
 */
import { encodeFunctionData, parseEther } from "viem";
import { erc20Abi, explorerTx } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { circleExecute, circleWalletAddress, circleWalletId } from "../apps/agents/src/circle";
import { publicClient, waitOk, wallet, chain } from "./lib";

async function main() {
  const dep = loadDeployment();
  const wid = circleWalletId("naive-00");
  if (!wid) throw new Error("CIRCLE_WALLET_ID_NAIVE00 not set (run pnpm circle:setup)");
  const addr = await circleWalletAddress(wid);
  console.log(`Circle wallet ${wid} → ${addr}`);
  const owner = wallet("DEPLOYER_KEY");
  const before = await publicClient.getBalance({ address: addr });
  if (before < parseEther("0.05")) {
    await waitOk(await owner.sendTransaction({ to: addr, value: parseEther("0.1"), chain, account: owner.account }), "gas → Circle wallet");
  }
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [addr, 0n] });
  console.log("Asking Circle to execute USDC.approve(self, 0) from the Circle wallet…");
  const hash = await circleExecute(wid, dep.usdc, data);
  const receipt = await publicClient.getTransactionReceipt({ hash });
  console.log(`✓ Circle-signed tx ${hash}\n  status ${receipt.status} · from ${receipt.from} · ${explorerTx(hash, dep.chainId)}`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
