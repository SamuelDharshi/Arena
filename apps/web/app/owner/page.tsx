"use client";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { useAccount } from "wagmi";
import {
  agentRegistryAbi,
  Allowlist,
  erc20Abi,
  formatUsdc,
  intentTypes,
  parseUsdc,
  policyWalletAbi,
  policyWalletDomain,
} from "@arena/shared";
import { api, useAgent, useAgents, useConfig, type AgentRow } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ensureArc, errorMessage, useArenaWallet, useTxRunner } from "@/lib/tx";
import { CHAIN_ID } from "@/lib/wagmi";
import { Empty, TierBadge, TxLink, Usdc } from "@/components/ui";

interface Escalation {
  id: string;
  payableId: string;
  intent: Record<string, string>;
  reason: string;
  status: string;
  txHash?: string;
  error?: string;
  createdAt: string;
}

function TxLog({ steps }: { steps: ReturnType<typeof useTxRunner>["steps"] }) {
  if (!steps.length) return null;
  return (
    <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
      {steps.map((s, i) => (
        <li key={i} className={s.status === "error" ? "text-breach" : s.status === "done" ? "text-accent" : "text-slate-400"}>
          {s.status === "done" ? "✓" : s.status === "error" ? "✗" : "…"} {s.label} {s.error ? `— ${s.error}` : ""} {s.hash && <TxLink hash={s.hash} />}
        </li>
      ))}
    </ul>
  );
}

function AgentConsole({ row }: { row: AgentRow }) {
  const { data: cfg } = useConfig();
  const { data: agent } = useAgent(row.id);
  const { address } = useAccount();
  const { token, signIn } = useAuth();
  const tx = useTxRunner();
  const qc = useQueryClient();
  const arenaWallet = useArenaWallet();
  const [amt, setAmt] = useState("5");
  const [msg, setMsg] = useState<string | null>(null);
  const [customHash, setCustomHash] = useState("");

  const pipelinesUrl = row.endpoint.replace(/\/agents\/[^/]+\/?$/, "/pipelines");
  const { data: pipelines } = useQuery({
    queryKey: ["pipelines", pipelinesUrl],
    queryFn: async () => (await (await fetch(pipelinesUrl)).json()) as { id: string; label: string; configHash: Hex }[],
    retry: false,
  });
  const { data: escalations, refetch: refetchEsc } = useQuery({
    queryKey: ["escalations", row.id],
    queryFn: () => api<Escalation[]>(`/v1/agents/${row.id}/escalations`),
    refetchInterval: 6000,
  });

  async function deposit(kind: "bounty" | "treasury") {
    if (!cfg || !address) return;
    setMsg(null);
    const v = parseUsdc(amt);
    try {
      await tx.run(`Approve ${formatUsdc(v)}`, (w) => w.writeContract({ address: cfg.deployment.usdc, abi: erc20Abi, functionName: "approve", args: [row.vault, v] }));
      await tx.run(`Deposit ${formatUsdc(v)} → ${kind}`, (w) =>
        w.writeContract({ address: row.vault, abi: policyWalletAbi, functionName: kind === "bounty" ? "depositBounty" : "depositTreasury", args: [v] }),
      );
      void qc.invalidateQueries();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  }

  async function withdraw(kind: "bounty" | "treasury") {
    const v = parseUsdc(amt);
    try {
      await tx.run(`Withdraw ${formatUsdc(v)} from ${kind}`, (w) =>
        w.writeContract({ address: row.vault, abi: policyWalletAbi, functionName: kind === "bounty" ? "withdrawBounty" : "withdrawTreasury", args: [v] }),
      );
      void qc.invalidateQueries();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  }

  async function patch(hash: Hex) {
    if (!cfg) return;
    try {
      await tx.run(`updateConfig → ${hash.slice(0, 10)}… (tier resets, score keeps 25%)`, (w) =>
        w.writeContract({ address: cfg.deployment.registry, abi: agentRegistryAbi, functionName: "updateConfig", args: [BigInt(row.id), hash] }),
      );
      setMsg("Patched. The keeper re-runs every exploit against the new config.");
      void qc.invalidateQueries();
    } catch (e) {
      setMsg(errorMessage(e));
    }
  }

  async function runPayable(payableId: string) {
    setMsg(null);
    try {
      const t = token ?? (await signIn());
      const r = await api<{ txHash: string | null; escalation: Escalation | null; error?: string; decision: { action: string; reasoning: string } }>(
        `/v1/agents/${row.id}/payables/run`,
        { method: "POST", token: t, body: JSON.stringify({ payableId }) },
      );
      setMsg(
        r.txHash
          ? `Paid autonomously within the on-chain limit (tx ${r.txHash.slice(0, 12)}…)`
          : r.escalation
            ? "Escalated: above the autonomous limit/threshold — needs your co-signature below."
            : `Agent decided: ${r.decision.action} — ${r.decision.reasoning}${r.error ? ` (${r.error})` : ""}`,
      );
      void refetchEsc();
      void qc.invalidateQueries({ queryKey: ["agents"] });
    } catch (e) {
      setMsg(errorMessage(e));
    }
  }

  async function cosign(e: Escalation) {
    try {
      if (!arenaWallet) throw new Error("wallet is still connecting, try again in a second");
      await ensureArc(arenaWallet);
      const signature = await arenaWallet.signTypedData({
        domain: policyWalletDomain(CHAIN_ID, row.vault),
        types: intentTypes,
        primaryType: "Intent",
        message: {
          agentId: BigInt(e.intent.agentId),
          to: e.intent.to as Address,
          amount: BigInt(e.intent.amount),
          category: e.intent.category as Hex,
          ref: e.intent.ref as Hex,
          nonce: BigInt(e.intent.nonce),
          deadline: BigInt(e.intent.deadline),
        },
      });
      const t = token ?? (await signIn());
      const r = await api<Escalation>(`/v1/agents/${row.id}/escalations/${e.id}/approve`, { method: "POST", token: t, body: JSON.stringify({ signature }) });
      setMsg(r.status === "approved" ? "Co-signed payment executed on-chain (flagged escalated)." : `Failed: ${r.error}`);
      void refetchEsc();
    } catch (err) {
      setMsg(errorMessage(err));
    }
  }

  const pending = (escalations ?? []).filter((e) => e.status === "pending" && Number(e.intent.deadline) > Date.now() / 1000);

  return (
    <section className="panel space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{row.name ?? `Agent #${row.id}`}</h2>
        <TierBadge tier={row.effective_tier} status={row.status} />
        <span className="text-xs text-slate-400">
          pool <Usdc v={row.bounty_pool} /> · locked <Usdc v={row.locked_bounty} /> · treasury <Usdc v={row.treasury} /> · limit <Usdc v={row.daily_limit} /> · spent{" "}
          <Usdc v={row.spent_window} />
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <div className="label">Fund / withdraw (USDC)</div>
          <input className="input mb-2" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary !px-3 !py-1.5 !text-xs" disabled={tx.busy} onClick={() => deposit("bounty")}>+ Bounty</button>
            <button className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={tx.busy} onClick={() => deposit("treasury")}>+ Treasury</button>
            <button className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={tx.busy} onClick={() => withdraw("bounty")}>− Bounty</button>
            <button className="btn-ghost !px-3 !py-1.5 !text-xs" disabled={tx.busy} onClick={() => withdraw("treasury")}>− Treasury</button>
          </div>
        </div>

        <div>
          <div className="label">Production payables (treasury path)</div>
          {agent?.info?.payables?.length ? (
            <ul className="space-y-1">
              {agent.info.payables.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{p.memo} · <Usdc v={p.amount} /></span>
                  <button className="btn-ghost !px-2 !py-1 !text-[11px]" onClick={() => runPayable(p.id)}>Run</button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-ink-500">This agent&apos;s runtime exposes no payables queue.</div>
          )}
          {pending.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="label !text-accent">Awaiting your co-signature</div>
              {pending.map((e) => (
                <div key={e.id} className="rounded border border-[#ff4fd8]/40 p-2 text-xs">
                  <div>{e.payableId} · <Usdc v={e.intent.amount} /> → {e.intent.to.slice(0, 10)}…</div>
                  <div className="text-ink-500">{e.reason}</div>
                  <button className="btn-primary mt-1 !px-2 !py-1 !text-[11px]" onClick={() => cosign(e)}>Co-sign (EIP-712)</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="label">Patch &amp; re-enter (new configHash)</div>
          <div className="mb-2 truncate font-mono text-[11px] text-ink-500" title={row.config_hash}>current {row.config_hash}</div>
          {pipelines?.map((p) => (
            <button
              key={p.id}
              disabled={tx.busy || p.configHash.toLowerCase() === row.config_hash.toLowerCase()}
              onClick={() => patch(p.configHash)}
              className="btn-ghost mb-1 w-full !justify-between !px-3 !py-1.5 !text-xs"
            >
              <span>{p.label}</span>
              <span className="font-mono text-ink-500">{p.configHash.toLowerCase() === row.config_hash.toLowerCase() ? "active" : p.configHash.slice(0, 8)}</span>
            </button>
          ))}
          <div className="mt-1 flex gap-1">
            <input className="input !py-1 !text-xs" placeholder="custom 0x… configHash" value={customHash} onChange={(e) => setCustomHash(e.target.value)} />
            <button className="btn-ghost !px-2 !py-1 !text-xs" disabled={!/^0x[0-9a-fA-F]{64}$/.test(customHash)} onClick={() => patch(customHash as Hex)}>Set</button>
          </div>
        </div>
      </div>
      {msg && <div className="rounded border border-ink-600 bg-ink-950 px-3 py-2 text-sm">{msg}</div>}
      <TxLog steps={tx.steps} />
    </section>
  );
}

function RegisterWizard() {
  const { data: cfg } = useConfig();
  const tx = useTxRunner();
  const qc = useQueryClient();
  const [f, setF] = useState({
    signer: "",
    endpoint: "https://",
    metadataURI: "https://",
    config: "",
    mandate: "Pay approved vendors only, within contract terms. Escalate anything else.",
    allowlist: "",
    perTxCap: "10",
    approvalThreshold: "5",
    floor: "2",
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const derived = useMemo(() => {
    const addrs = f.allowlist.split(/[\s,]+/).filter(Boolean);
    const bad = addrs.filter((a) => !isAddress(a));
    let root: Hex | null = null;
    if (addrs.length && !bad.length) root = new Allowlist(addrs).root;
    const configHash = /^0x[0-9a-fA-F]{64}$/.test(f.config.trim()) ? (f.config.trim() as Hex) : keccak256(toHex(f.config || "unset"));
    return { root, bad, configHash, mandateHash: keccak256(toHex(f.mandate)) };
  }, [f]);

  async function submit() {
    if (!cfg) return;
    setErr(null);
    if (!isAddress(f.signer)) return setErr("Signer must be an address (the agent's key, not yours).");
    if (!derived.root) return setErr("Allowlist needs at least one valid vendor address.");
    try {
      await tx.run("registerAgent (deploys your PolicyWallet clone)", (w) =>
        w.writeContract({
          address: cfg.deployment.registry,
          abi: agentRegistryAbi,
          functionName: "registerAgent",
          args: [
            f.signer as Address,
            derived.configHash,
            derived.mandateHash,
            derived.root!,
            f.endpoint,
            f.metadataURI,
            { perTxCap: parseUsdc(f.perTxCap), approvalThreshold: parseUsdc(f.approvalThreshold), windowSecs: 86400, floorDailyLimit: parseUsdc(f.floor) },
          ],
        }),
      );
      void qc.invalidateQueries({ queryKey: ["agents"] });
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  return (
    <section className="panel space-y-4 p-4">
      <div>
        <h2 className="text-lg font-semibold">Register an agent</h2>
        <p className="text-sm text-slate-400">
          Your agent implements AAP (<code className="font-mono">POST {"{endpoint}"}/aap/v1/turn</code>) and signs its own payments. Authority is enforced by the
          PolicyWallet — allowlist, per-tx cap, escalation threshold and a daily limit that grows only with proven bounty.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label><span className="label">Agent signer address</span><input className="input" value={f.signer} onChange={set("signer")} placeholder="0x… (Circle Wallet or agent key)" /></label>
        <label><span className="label">AAP endpoint</span><input className="input" value={f.endpoint} onChange={set("endpoint")} /></label>
        <label><span className="label">Metadata URI (JSON: name, description, mandate, contextInbox)</span><input className="input" value={f.metadataURI} onChange={set("metadataURI")} /></label>
        <label><span className="label">Config (0x hash, or text to hash: model ‖ prompt ‖ validators ‖ tools ‖ runtime)</span><input className="input" value={f.config} onChange={set("config")} /></label>
        <label className="md:col-span-2"><span className="label">Public mandate</span><textarea className="input min-h-[70px]" value={f.mandate} onChange={set("mandate")} /></label>
        <label className="md:col-span-2">
          <span className="label">Vendor allowlist (addresses, one per line) → Merkle root</span>
          <textarea className="input min-h-[80px]" value={f.allowlist} onChange={set("allowlist")} />
          <span className="mt-1 block font-mono text-[11px] text-ink-500">{derived.bad.length ? `invalid: ${derived.bad.join(", ")}` : derived.root ? `root ${derived.root}` : "—"}</span>
        </label>
        <label><span className="label">Per-tx cap (USDC)</span><input className="input" value={f.perTxCap} onChange={set("perTxCap")} /></label>
        <label><span className="label">Owner co-sign above (USDC)</span><input className="input" value={f.approvalThreshold} onChange={set("approvalThreshold")} /></label>
        <label><span className="label">Floor daily limit at T0 (USDC)</span><input className="input" value={f.floor} onChange={set("floor")} /></label>
        <div className="self-end font-mono text-[11px] text-ink-500">configHash {derived.configHash.slice(0, 18)}…<br />mandateHash {derived.mandateHash.slice(0, 18)}…</div>
      </div>
      <button className="btn-primary" onClick={submit} disabled={tx.busy}>Register agent</button>
      {err && <div className="text-sm text-breach">{err}</div>}
      <TxLog steps={tx.steps} />
    </section>
  );
}

export default function OwnerPage() {
  const { address } = useAccount();
  const { data: agents } = useAgents();
  const mine = (agents ?? []).filter((a) => address && a.owner.toLowerCase() === address.toLowerCase());
  return (
    <div className="space-y-6 pt-6">
      <div>
        <h1 className="text-3xl font-bold">Owner console</h1>
        <p className="mt-1 max-w-2xl text-slate-400">
          Autonomy that&apos;s earned, not configured: your agent&apos;s autonomous daily limit equals the bounty it has proven it can defend. Anything above it
          needs your EIP-712 co-signature — escalation is never silent.
        </p>
      </div>
      {!address ? (
        <Empty>Connect the wallet that owns your agents.</Empty>
      ) : mine.length ? (
        mine.map((a) => <AgentConsole key={a.id} row={a} />)
      ) : (
        <Empty>No agents owned by {address.slice(0, 10)}… yet.</Empty>
      )}
      <RegisterWizard />
    </div>
  );
}
