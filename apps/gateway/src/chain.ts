import { createPublicClient, createWalletClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  agentRegistryAbi,
  arenaCoreAbi,
  arenaDomain,
  attestationTypes,
  chainFor,
  RECEIPT_TIMEOUT_MS,
  exploitRegistryAbi,
  policyWalletAbi,
  type Attestation,
} from "@arena/shared";
import { env, rpcTransport, loadDeployment, type Deployment } from "@arena/shared/node";

export const chain = chainFor(env.chainId, env.rpcUrl);
export const publicClient = createPublicClient({ chain, transport: rpcTransport() });
export const attestor = privateKeyToAccount(env.key("GATEWAY_ATTESTOR_KEY"));
const attestorWallet = createWalletClient({ account: attestor, chain, transport: rpcTransport() });

let _dep: Deployment | null = null;
export function dep(): Deployment {
  if (!_dep) _dep = loadDeployment();
  return _dep;
}

export type ChainSession = Awaited<ReturnType<typeof getSession>>;

export function getSession(sid: bigint) {
  return publicClient.readContract({ address: dep().arena, abi: arenaCoreAbi, functionName: "getSession", args: [sid] });
}

export function getAgent(agentId: bigint) {
  return publicClient.readContract({ address: dep().registry, abi: agentRegistryAbi, functionName: "getAgent", args: [agentId] });
}

export function exploitOfSession(sid: bigint) {
  return publicClient.readContract({ address: dep().exploits, abi: exploitRegistryAbi, functionName: "exploitOfSession", args: [sid] });
}

export async function chainNow(): Promise<number> {
  const b = await publicClient.getBlock({ blockTag: "latest" });
  return Number(b.timestamp);
}

/** Signs an EIP-712 attestation and submits closeSession (gateway pays the gas). */
export async function attestAndClose(a: Attestation): Promise<{ signature: Hex; txHash: Hex }> {
  const signature = await attestor.signTypedData({
    domain: arenaDomain(chain.id, dep().arena),
    types: attestationTypes,
    primaryType: "Attestation",
    message: a,
  });
  const txHash = await attestorWallet.writeContract({
    address: dep().arena,
    abi: arenaCoreAbi,
    functionName: "closeSession",
    args: [{ sid: a.sid, msgCount: a.msgCount, transcriptRoot: a.transcriptRoot, endedAt: a.endedAt }, signature],
    chain,
    account: attestor,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  if (r.status !== "success") throw new Error(`closeSession reverted (${txHash})`);
  return { signature, txHash };
}

export async function expireSession(sid: bigint): Promise<Hex> {
  const txHash = await attestorWallet.writeContract({
    address: dep().arena,
    abi: arenaCoreAbi,
    functionName: "expireStale",
    args: [sid],
    chain,
    account: attestor,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  return txHash;
}

export async function publishExploit(sid: bigint, uri: string, transcriptHash: Hex, fixtureHash: Hex): Promise<{ txHash: Hex; exploitId: bigint | null }> {
  const txHash = await attestorWallet.writeContract({
    address: dep().exploits,
    abi: exploitRegistryAbi,
    functionName: "publish",
    args: [sid, uri, transcriptHash, fixtureHash],
    chain,
    account: attestor,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  const logs = parseEventLogs({ abi: exploitRegistryAbi, logs: r.logs, eventName: "ExploitPublished" });
  return { txHash, exploitId: logs[0]?.args.exploitId ?? null };
}

/** Parses a tx receipt for breach evidence (BountyPaid from the vault, Breach from the arena). */
export async function breachFromTx(hash: Hex): Promise<{ sid: bigint; payout: bigint; to: Address } | null> {
  const r = await publicClient.getTransactionReceipt({ hash });
  const paid = parseEventLogs({ abi: policyWalletAbi, logs: r.logs, eventName: "BountyPaid" });
  if (!paid.length) return null;
  return { sid: paid[0].args.sid, payout: paid[0].args.payout, to: paid[0].args.to };
}
