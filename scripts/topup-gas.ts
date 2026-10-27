/**
 * Tops up the operational wallets that pay gas on Arc (USDC): the gateway attestor, the keeper, and the Circle agent wallets.
 * Circle reserves max fee × gas limit up front (≈ $0.4 per transaction), so agent wallets need about $1 to keep working.
 *   pnpm exec tsx scripts/topup-gas.ts            # tops everything below MIN up to TARGET (defaults 1.0 / 2.0 USDC)
 */
import { formatEther, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, loadDeployment } from "../packages/shared/src/node";
import { circleWalletAddress, circleWalletId } from "../apps/agents/src/circle";
import { chain, publicClient, waitOk, wallet } from "./lib";

const MIN = parseEther(process.env.TOPUP_MIN || "1.0");
const TARGET = parseEther(process.env.TOPUP_TARGET || "2.0");

async function main() {
  const dep = loadDeployment();
  const owner = wallet("DEPLOYER_KEY");
  const targets: { name: string; address: Address }[] = [
    { name: "gateway attestor", address: dep.attestor },
    { name: "keeper", address: privateKeyToAccount(env.key("KEEPER_KEY")).address },
  ];
  for (const slug of ["naive-00", "treasurer-01", "treasurer-02", "clerk-03", "auditor-04", "sentinel-05"]) {
    const id = circleWalletId(slug);
    if (id) targets.push({ name: `circle wallet ${slug}`, address: await circleWalletAddress(id) });
  }
  console.log(`deployer ${formatEther(await publicClient.getBalance({ address: owner.account.address }))} USDC`);
  for (const t of targets) {
    const bal = await publicClient.getBalance({ address: t.address });
    if (bal >= MIN) {
      console.log(`  ok   ${t.name.padEnd(26)} ${formatEther(bal)} USDC`);
      continue;
    }
    await waitOk(await owner.sendTransaction({ to: t.address, value: TARGET - bal, chain, account: owner.account }), `top up ${t.name}: ${formatEther(bal)} → ${formatEther(TARGET)} USDC`);
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
