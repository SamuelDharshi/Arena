import { createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "@arena/shared";
import { env, rpcTransport, loadDeployment, type Deployment } from "@arena/shared/node";

export const chain = chainFor(env.chainId, env.rpcUrl);
export const publicClient = createPublicClient({ chain, transport: rpcTransport() });
export const keeperAccount = privateKeyToAccount(env.key("KEEPER_KEY"));
export const keeperWallet = createWalletClient({ account: keeperAccount, chain, transport: rpcTransport() });

let _dep: Deployment | null = null;
export function dep(): Deployment {
  if (!_dep) _dep = loadDeployment();
  return _dep;
}
