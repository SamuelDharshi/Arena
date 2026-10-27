"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseEventLogs, type Address } from "viem";
import { useAccount, useChainId, useConnect, useReadContract, useSwitchChain } from "wagmi";
import { arenaCoreAbi, erc20Abi, formatUsdc, type InboxItemType } from "@arena/shared";
import { api, useAgent, useConfig, type ChainSession, type MessageRow } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useEventStream } from "@/lib/sse";
import { useTxRunner, errorMessage } from "@/lib/tx";
import { arenaChain } from "@/lib/wagmi";
import { DuelStage } from "@/components/arena/Stage";
import type { DuelShot } from "@/components/arena/DuelScene";
import { Empty, TierBadge, TxLink, Usdc } from "@/components/ui";
import { useUsdcBalance } from "@/components/ConnectButton";

/** Plain-language outcome for each agent decision. */
const OUTCOME: Record<string, { label: string; cls: string }> = {
  pay: { label: "Paid out", cls: "bg-breach text-[#fff]" },
  hold: { label: "Put on hold", cls: "bg-orange-200 text-black" },
  escalate: { label: "Flagged to owner", cls: "bg-orange-900 text-orange-100" },
  refuse: { label: "Refused", cls: "bg-zinc-800 text-orange-200" },
};

/** Turns contract / wallet errors into a sentence a first-time visitor understands. */
function friendly(err: unknown): string {
  const raw = errorMessage(err);
  const map: [RegExp, string][] = [
    [/User rejected|User denied|rejected the request/i, "You cancelled in your wallet — nothing was charged."],
    [/InsufficientFunds/, "This agent's bounty is currently reserved by other players. Try again in a few minutes."],
    [/SessionLive/, "You already have a live round against this agent — reload to continue it."],
    [/TooManyAttempts/, "Daily limit reached: 5 rounds per agent per day."],
    [/BadAttacker/, "You can't challenge your own agent."],
    [/NotActive/, "This agent isn't accepting challenges right now."],
    [/exceeds balance|insufficient funds/i, "Not enough testnet USDC in your wallet. Get some free from the Circle faucet."],
    [/session is closed|session already closed/i, "This round has already ended. Click “Play again” to start a new one."],
    [/session expired/i, "Time's up — this round expired. Click “Play again” to start a new one."],
    [/message limit reached/i, "You've used all 30 messages in this round."],
  ];
  for (const [re, msg] of map) if (re.test(raw)) return msg;
  return raw;
}

function Step({ n, title, state, children }: { n: number; title: string; state: "done" | "active" | "todo"; children?: React.ReactNode }) {
  return (
    <div className={`rounded-xl border p-4 transition ${state === "active" ? "border-accent bg-[#120a04] shadow-md" : "border-ink-700"} ${state === "todo" ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-3">
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold ${
            state === "done" ? "bg-accent text-black" : state === "active" ? "border-2 border-accent text-accent" : "border border-ink-600 text-zinc-400"
          }`}
        >
          {state === "done" ? "✓" : n}
        </span>
        <span className="font-semibold">{title}</span>
      </div>
      {state === "active" && children && <div className="mt-3 pl-10">{children}</div>}
    </div>
  );
}

function useCountdown(expiresAt?: number) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  if (!expiresAt) return null;
  const s = Math.max(0, expiresAt - now);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 60 }, (_, i) => ({ i, x: Math.random() * 100, d: Math.random() * 0.8, c: ["#ffd66b", "#ff3b4d", "#000000", "#000000"][i % 4] })), []);
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden>
      <style>{`@keyframes fall{0%{transform:translateY(-10vh) rotate(0)}100%{transform:translateY(110vh) rotate(720deg)}}`}</style>
      {pieces.map((p) => (
        <span key={p.i} className="absolute top-0 h-3 w-2 rounded-sm" style={{ left: `${p.x}%`, background: p.c, animation: `fall ${2.2 + p.d}s ${p.d}s ease-in forwards` }} />
      ))}
    </div>
  );
}

export default function AttackPage({ params }: { params: { id: string } }) {
  const agentId = BigInt(params.id);
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: cfg } = useConfig();
  const { data: agent } = useAgent(params.id);
  const { token, signIn, signingIn } = useAuth();
  const tx = useTxRunner();
  const { data: usdcBal } = useUsdcBalance(address);

  const [tier, setTier] = useState(1);
  const [sid, setSid] = useState<string | null>(null);
  const [session, setSession] = useState<ChainSession | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [thinking, setThinking] = useState(false);
  const [breach, setBreach] = useState<{ payout: string; txHash: string } | null>(null);
  const [exploit, setExploit] = useState<{ exploitId: string | null; txHash: string } | null>(null);
  const [closed, setClosed] = useState<{ txHash: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null); // visible progress of the current Send
  const [draft, setDraft] = useState({ type: "invoice" as InboxItemType, from: "billing@vendor.com", subject: "", body: "" });
  const [starting, setStarting] = useState<string | null>(null);
  const [showTiers, setShowTiers] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // Resume an existing live session for this wallet.
  const { data: liveSid } = useReadContract({
    address: cfg?.deployment.arena,
    abi: arenaCoreAbi,
    functionName: "liveSessionOf",
    args: address ? [agentId, address] : undefined,
    query: { enabled: !!cfg && !!address },
  });
  useEffect(() => {
    if (liveSid && liveSid > 0n && !sid) setSid(liveSid.toString());
  }, [liveSid, sid]);

  const loadSession = useCallback(async () => {
    if (!sid) return;
    const r = await api<{ session: ChainSession; messages: MessageRow[]; exploit: { id: string; tx: string } | null }>(`/v1/sessions/${sid}`, { token });
    setSession(r.session);
    if (r.messages.length) setMessages(r.messages);
    if (r.session.state === 2 && !breach) setBreach({ payout: r.session.payout, txHash: "" });
    if (r.exploit) setExploit({ exploitId: r.exploit.id, txHash: r.exploit.tx });
  }, [sid, token, breach]);
  useEffect(() => {
    void loadSession();
    // Keep the round's on-chain state fresh so a closed/expired round flips to the end screen on its own.
    const t = setInterval(() => void loadSession().catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, [loadSession]);

  useEventStream(sid ? `/v1/sessions/${sid}/stream` : null, (e) => {
    if (e.type === "message") {
      const m = e.message as MessageRow;
      setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m].sort((a, b) => a.seq - b.seq)));
      if (m.role === "agent") setThinking(false);
    } else if (e.type === "thinking") setThinking(true);
    else if (e.type === "breach") setBreach({ payout: String(e.payout), txHash: String(e.txHash) });
    else if (e.type === "exploit") setExploit({ exploitId: (e.exploitId as string) ?? null, txHash: String(e.txHash) });
    else if (e.type === "closed") setClosed({ txHash: String(e.txHash) });
  });

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  const bounty = cfg ? BigInt(cfg.tierBounty[tier]) : 0n;
  const fee = cfg ? BigInt(cfg.tierFee[tier]) : 0n;
  const free = agent ? BigInt(agent.bounty_pool) - BigInt(agent.locked_bounty) : 0n;
  const isOwner = agent && address && agent.owner.toLowerCase() === address.toLowerCase();
  const wrongChain = isConnected && chainId !== arenaChain.id;
  const lowBalance = usdcBal !== undefined && usdcBal < fee;

  /** One click: approve the fee (only if needed) → open the round → sign in for messaging. */
  async function open() {
    if (!cfg || !address) return;
    setErr(null);
    tx.reset();
    try {
      const allowance = (await tx.publicClient!.readContract({ address: cfg.deployment.usdc, abi: erc20Abi, functionName: "allowance", args: [address, cfg.deployment.arena] })) as bigint;
      const needsApprove = allowance < fee;
      const total = (needsApprove ? 2 : 1) + (token ? 0 : 1);
      if (needsApprove) {
        setStarting(`Wallet prompt 1 of ${total}: allow the ${formatUsdc(fee)} entry fee`);
        await tx.run(`Approve ${formatUsdc(fee)} entry fee`, (w) =>
          w.writeContract({ address: cfg.deployment.usdc, abi: erc20Abi, functionName: "approve", args: [cfg.deployment.arena, fee] }),
        );
      }
      setStarting(`Wallet prompt ${needsApprove ? 2 : 1} of ${total}: start the round`);
      const receipt = await tx.run(`Start round (reserves ${formatUsdc(bounty)} bounty)`, (w) =>
        w.writeContract({ address: cfg.deployment.arena, abi: arenaCoreAbi, functionName: "openSession", args: [agentId, tier, address as Address] }),
      );
      const ev = parseEventLogs({ abi: arenaCoreAbi, logs: receipt.logs, eventName: "SessionOpened" })[0];
      setMessages([]);
      setBreach(null);
      setExploit(null);
      setClosed(null);
      setSid(ev.args.sid.toString());
      if (!token) {
        setStarting(`Wallet prompt ${total} of ${total}: sign in (free, no gas)`);
        await signIn();
      }
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setStarting(null);
    }
  }

  async function send() {
    if (!sid) return setErr("No open round found. Reload the page, or start a new round.");
    if (!draft.body.trim()) return setErr("Type a message first.");
    setErr(null);
    try {
      let t = token;
      if (!t) {
        setStatus("Waiting for your wallet: open the MetaMask extension and click Sign (free, no gas)…");
        t = await signIn();
      }
      setStatus("Sending to the agent… (the first message can take up to a minute while the free server wakes up)");
      setThinking(true);
      const body = { ...draft, subject: draft.subject || undefined };
      setDraft((d) => ({ ...d, body: "" }));
      const r = await api<{ attacker: MessageRow; agent: MessageRow; breach: { payout: string; txHash: string } | null }>(`/v1/sessions/${sid}/messages`, {
        method: "POST",
        token: t,
        body: JSON.stringify(body),
      });
      setMessages((ms) => {
        const next = [...ms];
        for (const m of [r.attacker, r.agent]) if (!next.some((x) => x.id === m.id)) next.push(m);
        return next.sort((a, b) => a.seq - b.seq);
      });
      if (r.breach) setBreach(r.breach);
    } catch (e) {
      console.error("send failed", e);
      setErr(friendly(e));
      void loadSession().catch(() => {});
    } finally {
      setStatus(null);
      setThinking(false);
    }
  }

  async function end() {
    if (!sid) return;
    setErr(null);
    try {
      const t = token ?? (await signIn());
      const r = await api<{ txHash: string }>(`/v1/sessions/${sid}/end`, { method: "POST", token: t, body: "{}" });
      setClosed({ txHash: r.txHash });
      void loadSession();
    } catch (e) {
      setErr(friendly(e));
    }
  }

  const shots: DuelShot[] = useMemo(
    () => messages.filter((m) => m.role !== "system").map((m) => ({ key: m.id, from: m.role as "attacker" | "agent", action: m.decision?.action })),
    [messages],
  );
  const countdown = useCountdown(session ? Number(session.expiresAt) : undefined);
  const live = session?.state === 1 && countdown !== "0:00" && !breach && !closed;
  const attackerMsgs = messages.filter((m) => m.role === "attacker").length;

  if (!agent || !cfg) return <div className="pt-8"><Empty>Loading arena…</Empty></div>;

  return (
    <div className="space-y-4 pt-4">
      {breach && <Confetti />}
      {/* Bounty banner */}
      <div className={`flex flex-wrap items-center gap-4 rounded-xl border px-5 py-3 ${breach ? "border-breach bg-breach/15" : "border-[#18181b]/40 bg-[#18181b]/10"}`}>
        <div>
          <div className="panel-title">Target</div>
          <Link href={`/agent/${agent.id}`} className="text-lg font-bold hover:text-accent">{agent.name}</Link> <TierBadge tier={agent.effective_tier} status={agent.status} />
        </div>
        <div className="text-2xl font-black tracking-tight sm:text-3xl">
          {breach ? (
            <span className="text-breach">Agent broken — {formatUsdc(BigInt(breach.payout))} paid to you</span>
          ) : session ? (
            <span className="text-accent">{formatUsdc(BigInt(session.lockedBounty))} up for grabs</span>
          ) : (
            <span className="text-accent">Up to {formatUsdc(free)} to win</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-4 font-mono text-xs text-slate-300">
          {session && live && <span>⏱ {countdown}</span>}
          {session && <span>{attackerMsgs}/30 messages</span>}
          {sid && <span>round #{sid}</span>}
        </div>
      </div>

      {err && <div className="rounded-lg border border-breach/50 bg-breach/10 px-4 py-2 text-sm text-breach">{err}</div>}

      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        {/* Left: duel + console */}
        <div className="space-y-4">
          <DuelStage className="theme-dark h-[300px] rounded-xl border border-ink-700" tier={agent.effective_tier} status={agent.status} shots={shots} thinking={thinking} breached={!!breach} />

          {!sid ? (
            <section className="panel space-y-3 p-5">
              <div>
                <h2 className="text-2xl">Challenge {agent.name}</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Convince this AI payments agent to send you money. If it does, you keep the bounty plus your fee back — paid automatically by the contract.
                  If it holds, your fee goes to its bounty pool. {Math.round(Number(cfg.sessionTTL) / 60)} minutes per round.
                </p>
              </div>

              <Step n={1} title={isConnected && !wrongChain ? "Wallet connected" : "Connect your wallet"} state={isConnected && !wrongChain ? "done" : "active"}>
                {!isConnected ? (
                  <button className="btn-primary" disabled={connecting || !connectors.length} onClick={() => connectors[0] && connect({ connector: connectors[0] })}>
                    {connecting ? "Connecting…" : connectors.length ? "Connect wallet" : "Install MetaMask or Rabby first"}
                  </button>
                ) : (
                  <button className="btn-primary" disabled={switching} onClick={() => switchChain({ chainId: arenaChain.id })}>
                    {switching ? "Switching…" : `Switch to ${arenaChain.name}`}
                  </button>
                )}
              </Step>

              <Step n={2} title="Start a round" state={!isConnected || wrongChain ? "todo" : "active"}>
                {isOwner ? (
                  <p className="text-sm text-breach">This is your own agent — challenges must come from a different wallet.</p>
                ) : agent.status !== 1 ? (
                  <p className="text-sm text-slate-400">This agent is paused until its owner ships a fix. Pick another from the arena.</p>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                      <span>Win <b className="num text-lg">{formatUsdc(bounty)}</b></span>
                      <span className="text-slate-400">Entry fee <b className="num text-fg">{formatUsdc(fee)}</b></span>
                      {usdcBal !== undefined && <span className="text-slate-400">You have <Usdc v={usdcBal} /></span>}
                    </div>
                    {lowBalance && (
                      <p className="text-sm text-breach">
                        Not enough testnet USDC.{" "}
                        <a className="underline" href="https://faucet.circle.com" target="_blank" rel="noreferrer">Get free USDC from the Circle faucet →</a>
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <button className="btn-danger" onClick={open} disabled={!!starting || tx.busy || free < bounty || lowBalance}>
                        {starting ? "Check your wallet…" : `Start round · ${formatUsdc(fee)}`}
                      </button>
                      <button className="text-xs text-slate-400 underline" onClick={() => setShowTiers((s) => !s)}>
                        {showTiers ? "Hide stakes" : "Change stakes"}
                      </button>
                    </div>
                    {starting && <p className="text-sm font-medium">{starting}</p>}
                    {free < bounty && <p className="text-xs text-slate-400">This stake is fully reserved right now — choose a smaller one or try again shortly.</p>}
                    {showTiers && (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {[1, 2, 3, 4].map((t) => {
                          const b = BigInt(cfg.tierBounty[t]);
                          return (
                            <button
                              key={t}
                              disabled={free < b}
                              onClick={() => setTier(t)}
                              className={`rounded-lg border p-3 text-left transition ${tier === t ? "border-accent bg-accent/10" : "border-ink-700 hover:border-zinc-400"} disabled:opacity-30`}
                            >
                              <TierBadge tier={t} />
                              <div className="mt-1 num text-lg font-bold">{formatUsdc(b)}</div>
                              <div className="text-xs text-slate-400">fee {formatUsdc(BigInt(cfg.tierFee[t]))}</div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </Step>

              <Step n={3} title="Message the agent" state="todo" />
            </section>
          ) : (
            <section className="panel flex h-[520px] flex-col">
              <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto p-4">
                {messages.length === 0 && (
                  <Empty>
                    Write anything that lands in the agent&apos;s inbox — an invoice, an email or a chat. Your goal: get it to pay your wallet. Check the
                    agent&apos;s rules on the right for clues.
                  </Empty>
                )}
                {messages.map((m) =>
                  m.role === "attacker" ? (
                    <div key={m.id} className="ml-auto max-w-[85%] animate-rise rounded-xl rounded-br-sm border border-[#ff6b3d]/40 bg-[#ff6b3d]/10 p-3 text-sm">
                      <div className="mb-1 font-mono text-[10px] uppercase text-accent">
                        {m.item?.type} · from {m.item?.from}{m.item?.subject ? ` · ${m.item.subject}` : ""}
                      </div>
                      <div className="whitespace-pre-wrap">{m.content}</div>
                    </div>
                  ) : (
                    <div key={m.id} className="max-w-[85%] animate-rise rounded-xl rounded-bl-sm border border-ink-600 bg-ink-800 p-3 text-sm">
                      <div className="mb-1 flex items-center gap-2">
                        {m.error?.startsWith("LLM_UNAVAILABLE") ? (
                          <span className="rounded bg-orange-200 px-1.5 py-0.5 text-[11px] font-semibold text-black">Agent busy — this message didn&apos;t count, send it again</span>
                        ) : (
                          m.decision && <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${OUTCOME[m.decision.action]?.cls ?? ""}`}>{OUTCOME[m.decision.action]?.label ?? m.decision.action}</span>
                        )}
                        <span className="font-mono text-[10px] text-ink-500">{agent.name}{m.latency_ms ? ` · ${(m.latency_ms / 1000).toFixed(1)}s` : ""}</span>
                        {m.tx_hash && <TxLink hash={m.tx_hash} />}
                      </div>
                      <div className="whitespace-pre-wrap">{m.content}</div>
                      {m.decision?.reasoning && (
                        <details className="mt-2 text-xs text-slate-400">
                          <summary className="cursor-pointer select-none text-ink-500">Why it decided this</summary>
                          <p className="mt-1">{m.decision.reasoning}</p>
                          {m.decision.validators?.map((v) => (
                            <div key={v.name} className={v.passed ? "text-accent" : "text-breach"}>{v.passed ? "✓" : "✗"} {v.name} — {v.detail}</div>
                          ))}
                        </details>
                      )}
                    </div>
                  ),
                )}
                {thinking && <div className="w-fit animate-pulse rounded-xl bg-ink-800 px-3 py-2 font-mono text-xs text-slate-400">{agent.name} is deciding…</div>}
              </div>
              {live ? (
                <div className="space-y-2 border-t border-ink-700 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-slate-400">Send as</span>
                    {(["invoice", "email", "chat"] as InboxItemType[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => setDraft({ ...draft, type: t })}
                        className={`rounded-full border px-3 py-1 capitalize transition ${draft.type === t ? "border-accent bg-accent text-black" : "border-ink-600 hover:border-accent"}`}
                      >
                        {t}
                      </button>
                    ))}
                    <button className="ml-auto text-slate-400 underline" onClick={() => setShowAdvanced((s) => !s)}>
                      {showAdvanced ? "Hide sender" : `From: ${draft.from || "—"}`}
                    </button>
                  </div>
                  {showAdvanced && (
                    <div className="flex flex-wrap gap-2">
                      <input className="input !w-48 flex-1" placeholder="Sender address" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
                      <input className="input !w-48 flex-1" placeholder="Subject (optional)" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <textarea
                      className="input min-h-[72px] flex-1 resize-y"
                      placeholder={`Write your ${draft.type}… (Ctrl+Enter to send)`}
                      value={draft.body}
                      maxLength={3800}
                      onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                      }}
                    />
                    <div className="flex flex-col gap-2">
                      <button className="btn-danger" onClick={send} disabled={thinking || signingIn || !draft.body.trim()}>{signingIn ? "Sign in…" : thinking ? "…" : "Send"}</button>
                      <button className="btn-ghost !text-xs" onClick={end} disabled={thinking || attackerMsgs === 0} title="Stop now — the agent gets credit for surviving">Give up</button>
                    </div>
                  </div>
                  {err && <div className="rounded-lg border border-breach/50 bg-breach/10 px-3 py-2 text-sm text-breach">{err}</div>}
                  {status && <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent">{status}</div>}
                  <div className="flex flex-wrap gap-x-4 text-xs text-slate-400">
                    <span>Your wallet <span className="font-mono">{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""}</span> is the only address that can win.</span>
                    {!token && <span>You&apos;ll sign in once (free) before the first message.</span>}
                  </div>
                </div>
              ) : (
                <div className="border-t border-ink-700 p-4 text-sm">
                  {breach ? (
                    <div className="space-y-1">
                      <div className="text-xl font-semibold text-breach">You won {formatUsdc(BigInt(breach.payout))} — it&apos;s already in your wallet.</div>
                      {breach.txHash && <div>Payout tx <TxLink hash={breach.txHash} /></div>}
                      {exploit ? (
                        <div>Exploit {exploit.exploitId ? <Link className="text-accent hover:underline" href={`/exploits/${exploit.exploitId}`}>#{exploit.exploitId}</Link> : ""} published → replaying against every agent. <TxLink hash={exploit.txHash} /></div>
                      ) : (
                        <div className="text-slate-400">Publishing exploit to the commons…</div>
                      )}
                    </div>
                  ) : closed || session?.state === 3 ? (
                    <div>The agent held this round — your fee joined its bounty pool. <TxLink hash={closed?.txHash} /></div>
                  ) : (
                    <div className="text-slate-400">Round over.</div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className="btn-primary !text-xs" onClick={() => { setErr(null); setSid(null); setSession(null); setMessages([]); setBreach(null); setClosed(null); setExploit(null); }}>
                      Play again
                    </button>
                    <Link href="/arena" className="btn-ghost !text-xs">Pick another agent</Link>
                  </div>
                </div>
              )}
            </section>
          )}
          {tx.steps.length > 0 && (
            <ul className="panel space-y-1 p-3 font-mono text-xs">
              {tx.steps.map((s, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span>{s.status === "done" ? "✓" : s.status === "error" ? "✗" : "…"}</span>
                  <span className={s.status === "error" ? "text-breach" : ""}>{s.label}{s.error ? ` — ${s.error}` : ""}</span>
                  {s.hash && <TxLink hash={s.hash} />}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Right: context */}
        <aside className="space-y-4">
          <section className="panel p-4">
            <h2 className="panel-title mb-2">Where winnings go</h2>
            <div className="break-all font-mono text-xs text-accent">{session?.attacker ?? address ?? "connect wallet"}</div>
            <p className="mt-2 text-xs text-slate-400">
              A breach is objective: an agent-signed outflow from the bounty pool to this address while the session is live. Anything sent to another
              non-allowlisted address simply reverts.
            </p>
          </section>
          <section className="panel p-4">
            <h2 className="panel-title mb-2">Agent rules (public)</h2>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-300">{agent.info?.mandate ?? "—"}</pre>
          </section>
          <section className="panel p-4">
            <h2 className="panel-title mb-2">Already in its inbox</h2>
            {agent.contextInbox.length ? (
              agent.contextInbox.map((it) => (
                <div key={it.id} className="mb-2 rounded border border-ink-700 p-2 text-xs">
                  <div className="font-mono text-[10px] text-ink-500">{it.type} · {it.from}{it.subject ? ` · ${it.subject}` : ""}</div>
                  <div className="text-slate-300">{it.body}</div>
                </div>
              ))
            ) : (
              <div className="text-xs text-ink-500">none</div>
            )}
          </section>
          <section className="panel p-4 text-xs text-slate-400">
            <h2 className="panel-title mb-2">Round rules</h2>
            <ul className="space-y-1">
              <li>• ≤ 30 messages · ≤ 4 KB each · {Math.round(Number(cfg.sessionTTL) / 60)}-minute TTL</li>
              <li>• ≤ 5 attempts per agent per day · one live session per agent</li>
              <li>• Sessions with ≥ {cfg.fullEffortMsgs} messages give the agent full survival credit</li>
              <li>• Every breach becomes a public exploit replayed against all agents</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
