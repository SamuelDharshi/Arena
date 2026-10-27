import { randomBytes } from "node:crypto";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { agentRegistryAbi, chainFor, policyWalletAbi, RECEIPT_TIMEOUT_MS, type Intent } from "@arena/shared";
import { env, rpcTransport, loadDeployment } from "@arena/shared/node";
import { agentBySlug, pipelineByHash, PIPELINES, type AgentDef, type Pipeline } from "./definitions";
import { circleExecute, circleWalletAddress, circleWalletId } from "./circle";

export const chain = chainFor(env.chainId, env.rpcUrl);
export const publicClient = createPublicClient({ chain, transport: rpcTransport() });

export interface AgentContext {
  def: AgentDef;
  signer: Address;
  agentId: bigint;
  vault: Address;
  configHash: Hex;
  pipeline: Pipeline;
  status: number;
  circleWallet?: string;
}

const local = new Map<string, PrivateKeyAccount>();

function localAccount(def: AgentDef): PrivateKeyAccount {
  let a = local.get(def.slug);
  if (!a) {
    a = privateKeyToAccount(env.key(def.keyEnv));
    local.set(def.slug, a);
  }
  return a;
}

export async function signerAddress(def: AgentDef): Promise<Address> {
  const wid = circleWalletId(def.slug);
  return wid ? circleWalletAddress(wid) : localAccount(def).address;
}

/** Resolves the agent's on-chain identity and the pipeline matching its registered configHash. */
const ctxCache = new Map<string, { at: number; ctx: Promise<AgentContext> }>();

/** Cached for 15s — status/config rarely change and every turn needs it (keeps public RPCs from throttling). */
export function agentContext(slug: string): Promise<AgentContext> {
  const hit = ctxCache.get(slug);
  if (hit && Date.now() - hit.at < 15_000) return hit.ctx;
  const ctx = loadAgentContext(slug);
  ctxCache.set(slug, { at: Date.now(), ctx });
  ctx.catch(() => ctxCache.delete(slug));
  return ctx;
}

async function loadAgentContext(slug: string): Promise<AgentContext> {
  const def = agentBySlug(slug);
  if (!def) throw new Error(`unknown agent ${slug}`);
  const dep = loadDeployment();
  const signer = await signerAddress(def);
  const agentId = await publicClient.readContract({
    address: dep.registry,
    abi: agentRegistryAbi,
    functionName: "agentOfSigner",
    args: [signer],
  });
  if (agentId === 0n) {
    return {
      def,
      signer,
      agentId: 0n,
      vault: "0x0000000000000000000000000000000000000000",
      configHash: "0x",
      pipeline: PIPELINES[def.defaultPipeline],
      status: 0,
    };
  }
  const a = await publicClient.readContract({
    address: dep.registry,
    abi: agentRegistryAbi,
    functionName: "getAgent",
    args: [agentId],
  });
  const pipeline = pipelineByHash(a.configHash) ?? PIPELINES[def.defaultPipeline];
  return {
    def,
    signer,
    agentId,
    vault: a.vault,
    configHash: a.configHash,
    pipeline,
    status: a.status,
    circleWallet: circleWalletId(def.slug),
  };
}

export function newNonce(): bigint {
  return BigInt("0x" + randomBytes(8).toString("hex")) & ((1n << 63n) - 1n);
}

export function buildIntent(agentId: bigint, to: Address, amount: bigint, category: Hex, ref: Hex): Intent {
  return {
    agentId,
    to,
    amount,
    category,
    ref,
    nonce: newNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  };
}

export class ChainRevert extends Error {
  constructor(
    public readonly errorName: string,
    message: string,
  ) {
    super(message);
  }
}

function decodeRevert(err: unknown): ChainRevert {
  if (err instanceof BaseError) {
    // A raw eth_call (we simulate with encoded calldata) surfaces the revert as bare data, not a ContractFunctionRevertedError.
    const raw = err.walk((e) => typeof (e as { data?: unknown }).data === "string" && ((e as { data: string }).data.startsWith("0x")));
    const rawData = (raw as { data?: Hex } | null)?.data;
    if (rawData && rawData.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi: policyWalletAbi, data: rawData });
        return new ChainRevert(decoded.errorName, decoded.errorName);
      } catch {
        /* not a PolicyWallet error: fall through */
      }
    }
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      const name = r.data?.errorName ?? "Revert";
      return new ChainRevert(name, `${name}${r.reason ? `: ${r.reason}` : ""}`);
    }
    return new ChainRevert("Error", err.shortMessage);
  }
  return new ChainRevert("Error", err instanceof Error ? err.message : String(err));
}

async function send(
  ctx: AgentContext,
  fn: "payBounty" | "payProduction",
  args: readonly unknown[],
): Promise<Hex> {
  const data = encodeFunctionData({ abi: policyWalletAbi, functionName: fn, args: args as never });
  // Simulate first so policy reverts surface as typed errors (and never cost gas).
  try {
    await publicClient.call({ account: ctx.signer, to: ctx.vault, data });
  } catch (err) {
    throw decodeRevert(err);
  }
  let hash: Hex;
  if (ctx.circleWallet) {
    hash = await circleExecute(ctx.circleWallet, ctx.vault, data);
  } else {
    const wallet = createWalletClient({ account: localAccount(ctx.def), chain, transport: rpcTransport() });
    hash = await wallet.sendTransaction({ to: ctx.vault, data, chain, account: localAccount(ctx.def) });
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new ChainRevert("Reverted", `transaction ${hash} reverted`);
  return hash;
}

export function payBounty(ctx: AgentContext, intent: Intent, proof: Hex[]): Promise<Hex> {
  return send(ctx, "payBounty", [intent, proof]);
}

export function payProduction(ctx: AgentContext, intent: Intent, proof: Hex[], ownerSig: Hex = "0x"): Promise<Hex> {
  return send(ctx, "payProduction", [intent, proof, ownerSig]);
}

export async function anchorDecision(ctx: AgentContext, logHash: Hex, count: number): Promise<Hex> {
  const dep = loadDeployment();
  const data = encodeFunctionData({
    abi: agentRegistryAbi,
    functionName: "anchorDecision",
    args: [ctx.agentId, logHash, count],
  });
  if (ctx.circleWallet) return circleExecute(ctx.circleWallet, dep.registry, data);
  const wallet = createWalletClient({ account: localAccount(ctx.def), chain, transport: rpcTransport() });
  return wallet.sendTransaction({ to: dep.registry, data, chain, account: localAccount(ctx.def) });
}
