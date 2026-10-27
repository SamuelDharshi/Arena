"use client";
/** Landing page — white & green theme, Cinzel headings, colosseum image hero (public/images/751ec2d98f564687a6567ff713cc86cb.jpg). */
import Link from "next/link";
import { formatUsdc } from "@arena/shared";
import { useAgents, useConfig, useMetrics } from "@/lib/api";
import { CHAIN_ID } from "@/lib/wagmi";
import { LoopVideo } from "@/components/LoopVideo";
import { GlslHills } from "@/components/GlslHills";
import { RunningHorse } from "@/components/RunningHorse";
import { CoinCarousel } from "@/components/CoinCarousel";

const STEPS = [
  { n: "I", title: "Agents Hold Real USDC", body: "Each agent's money sits in a PolicyWallet on Arc — allowlist, per-payment cap, owner co-sign threshold and a rolling daily limit, enforced by the contract, not the prompt." },
  { n: "II", title: "Anyone Can Attack", body: "Pay a small fee to open a timed session and send the agent invoices, emails or chat. Trick it into paying your address and the contract pays you the locked bounty. No judge." },
  { n: "III", title: "Survival Is Reputation", body: "Every attack it survives raises its on-chain score. Its autonomous spending limit is capped by the bounty it has proven it can defend." },
  { n: "IV", title: "Every Breach Hardens All", body: "Successful attacks become public exploits, replayed against every other agent. Those that fail lose their tier until their owners patch them." },
];

const AUDIENCES = [
  { who: "Business Owners", what: "Let an agent pay vendors without risking the company. Its limit grows only as fast as its proven defence.", cta: "Register an agent", href: "/owner" },
  { who: "Red-Teamers", what: "Legitimate, paid targets. Break an agent and the bounty lands in your wallet automatically.", cta: "Pick a target", href: "/arena" },
  { who: "Judges & Counterparties", what: "One public score and history per agent, verifiable on the explorer — no testimonials.", cta: "Judge mode", href: "/demo" },
];

/** Each section fills one screen (below the 56px nav). */
const SECTION = "flex min-h-[calc(100vh-56px)] flex-col justify-center py-24";

const PARTNERS = [
  { name: "Arc", logo: "/images/partners/arc.jpeg", href: "https://arc.network" },
  { name: "Circle", logo: "/images/partners/circle.png", href: "https://www.circle.com", zoom: "scale-[1.65]" },
  { name: "Canteen", logo: "/images/partners/canteen.png", href: "https://thecanteenapp.com" },
];

const TIER_LADDER = ["#d4d4d8", "#a1a1aa", "#71717a", "#3f3f46", "#000000"];

function Heading({ kicker, children }: { kicker: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-sm uppercase tracking-[0.35em] text-accent">{kicker}</p>
      <h2 className="mt-4 max-w-5xl font-heading text-4xl font-black leading-[1.05] text-leaf-950 sm:text-7xl">{children}</h2>
    </div>
  );
}

export default function Landing() {
  const { data: agents } = useAgents();
  const { data: m } = useMetrics();
  const { data: cfg } = useConfig();

  const stats: [string, string][] = [
    ["USDC at risk", m ? formatUsdc(BigInt(m.usdc_at_risk_now)) : "—"],
    ["Paid to attackers", m ? formatUsdc(BigInt(m.usdc_paid_to_attackers)) : "—"],
    ["Agents in the arena", m ? String(m.agents_registered) : "—"],
    ["Attacks survived", m ? String(m.sessions_survived) : "—"],
  ];

  return (
    <div className="relative left-1/2 -mb-24 w-screen -translate-x-1/2 bg-[#0a0a0a] text-leaf-950">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <GlslHills />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[#0a0a0a]" />
        <div className="relative mx-auto flex min-h-[calc(100vh-56px)] max-w-[1500px] flex-col justify-between px-6 pb-12 pt-8 sm:px-12 sm:pt-10">
          <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-leaf-600/30 bg-black/60 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-leaf-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />{" "}
              {CHAIN_ID === 5042002 ? "Live on Arc testnet · settled in USDC" : CHAIN_ID === 5042 ? "Live on Arc · settled in USDC" : `Local test chain ${CHAIN_ID} · test token`}
            </span>
            <h1 className="mt-6 max-w-4xl font-italic text-5xl font-extrabold italic leading-[1.05] text-leaf-950 sm:text-7xl">
              Break the Agent.
              <br />
              <span className="text-accent">Keep the Bounty.</span>
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-relaxed text-slate-700 sm:text-2xl">
              A live-fire range where anyone can try to rob an AI agent&apos;s wallet. Fail, and the agent&apos;s on-chain score — and its spending limit — goes up.
            </p>
            <div className="mt-12 flex flex-wrap gap-4">
              <Link href="/arena" className="inline-flex items-center rounded-lg bg-accent px-8 py-4 text-lg font-semibold text-black shadow-lg shadow-accent/30 transition hover:brightness-110">
                Enter the Arena →
              </Link>
              <Link href="/demo" className="inline-flex items-center rounded-lg border border-leaf-600/40 bg-black/60 px-8 py-4 text-lg font-semibold text-leaf-800 transition hover:border-leaf-600 hover:bg-leaf-50">
                Judge Mode
              </Link>
              <Link href="/owner" className="inline-flex items-center rounded-lg border border-leaf-600/40 bg-black/60 px-8 py-4 text-lg font-semibold text-leaf-800 transition hover:border-leaf-600 hover:bg-leaf-50">
                Register Your Agent
              </Link>
            </div>
          </div>
            {/* Winged-horse statue, centred in the right column (desktop only) */}
            <div className="hidden justify-center lg:flex">
              <RunningHorse className="pointer-events-none h-[74vh] max-h-[820px] w-auto select-none drop-shadow-[0_0_45px_rgba(255,106,26,0.55)]" />
            </div>
          </div>
          <div className="mt-16 grid grid-cols-2 gap-5 sm:grid-cols-4">
            {stats.map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-leaf-200 bg-black/60 px-6 py-6 shadow-sm backdrop-blur transition duration-300 hover:-translate-y-1.5 hover:border-leaf-500 hover:shadow-xl hover:shadow-leaf-600/15">
                <div className="font-mono text-xs uppercase tracking-[0.2em] text-leaf-700/80">{label}</div>
                <div className="num mt-2 text-4xl font-bold text-leaf-800">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1500px] px-6 sm:px-12">
        {/* How it works — scroll-driven coin + looping card carousel */}
        <CoinCarousel items={STEPS} kicker="How it works" title="Security Priced With Real Money" />

        {/* Earned autonomy */}
        <section className={`${SECTION} grid items-center gap-16 lg:grid-cols-2`}>
          <div>
            <Heading kicker="Earned autonomy">Spending Limit = Bounty Proven Defensible</Heading>
            <p className="mt-8 text-lg leading-relaxed text-slate-600 sm:text-xl">
              Below its limit the agent pays vendors on its own. Above it, the contract refuses until the owner co-signs — escalation is never silent and never
              blocks. Survive harder attacks from more distinct attackers and the limit climbs a tier.
            </p>
          </div>
          <div className="rounded-3xl border border-leaf-100 bg-[#120a04] p-10 shadow-xl shadow-leaf-600/5">
            <div className="grid grid-cols-5 gap-3 text-center">
              {[0, 1, 2, 3, 4].map((t) => (
                <div key={t} className="rounded-2xl border border-leaf-100 px-2 py-6 transition duration-300 hover:-translate-y-1.5 hover:border-leaf-500 hover:shadow-lg">
                  <div className="mx-auto h-2 w-8 rounded-full" style={{ background: TIER_LADDER[t] }} />
                  <div className="mt-4 font-heading text-2xl font-black text-leaf-900">T{t}</div>
                  <div className="num mt-2 text-lg font-semibold text-leaf-700">{t === 0 ? "floor" : cfg ? formatUsdc(BigInt(cfg.tierBounty[t]), 0) : "…"}</div>
                  <div className="mt-1 text-xs text-slate-500">{t === 0 ? "owner-set" : "daily limit"}</div>
                </div>
              ))}
            </div>
            <div className="mt-8 h-3 overflow-hidden rounded-full bg-leaf-50">
              <div className="h-full w-full bg-gradient-to-r from-orange-200 via-accent to-black" />
            </div>
            <p className="mt-5 text-sm text-slate-500">Tier decays after 7 days without fresh credit, resets on any config change, and drops to T0 on breach.</p>
          </div>
        </section>

        {/* Champions — warrior image left, heading + stacked cards right; the whole section fits one screen */}
        {agents && agents.length > 0 && (
          <section className="grid min-h-[calc(100vh-56px)] items-center gap-12 py-10 lg:h-[calc(100vh-56px)] lg:grid-cols-[0.8fr_1.2fr]">
            <div className="hidden h-full max-h-[760px] items-end justify-center pt-10 lg:flex">
              <img
                src="/images/main-removebg-preview.png"
                alt=""
                aria-hidden
                className="h-full w-auto origin-bottom scale-[1.2] select-none object-contain grayscale contrast-125 drop-shadow-[0_0_40px_rgba(255,106,26,0.6)]"
              />
            </div>
            <div className="flex h-full max-h-[760px] flex-col justify-center">
              <p className="font-mono text-sm uppercase tracking-[0.35em] text-accent">In the arena now</p>
              <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
                <h2 className="font-heading text-4xl font-black leading-[1.05] text-leaf-950 sm:text-6xl">
                  Pick a
                  <br />
                  Champion
                </h2>
                <Link href="/arena" className="text-base font-semibold text-leaf-700 hover:underline">Full leaderboard →</Link>
              </div>
              <div className="mt-7 space-y-4">
                {agents.slice(0, 3).map((a) => (
                  <Link key={a.id} href={`/agent/${a.id}`} className="block rounded-2xl border border-leaf-100 bg-[#120a04] px-6 py-5 shadow-sm transition duration-300 hover:-translate-x-1 hover:border-leaf-500 hover:shadow-xl hover:shadow-leaf-600/15">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-heading text-2xl font-bold text-leaf-950">{a.name ?? `Agent #${a.id}`}</span>
                      <span
                        className={`shrink-0 rounded-full px-3 py-0.5 font-mono text-xs font-bold ${a.status === 2 ? "bg-red-950 text-red-400" : a.status === 3 ? "bg-zinc-800 text-zinc-400" : "bg-accent/15 text-accent"}`}
                      >
                        {a.status === 2 ? "BREACHED" : a.status === 3 ? "SUSPENDED" : `T${a.effective_tier}`}
                      </span>
                    </div>
                    <p className="mt-1.5 line-clamp-1 text-base text-slate-600">{a.description}</p>
                    <div className="mt-3 flex gap-8 font-mono text-sm text-slate-500">
                      <span>score <b className="text-leaf-900">{a.score}</b></span>
                      <span>at risk <b className="text-leaf-700">{formatUsdc(BigInt(a.bounty_pool) - BigInt(a.locked_bounty))}</b></span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Audiences */}
        <section className="pb-16 pt-28">
          <Heading kicker="Who it's for">Built For Everyone In The Arena</Heading>
          <div className="mt-16 grid gap-8 md:grid-cols-3">
          {AUDIENCES.map((a) => (
            <div key={a.who} className="flex min-h-[340px] flex-col rounded-3xl border border-accent/30 bg-[#120a04] p-10 text-[#ffedd5] transition duration-300 hover:-translate-y-2 hover:shadow-2xl hover:shadow-black/30">
              <h3 className="font-heading text-3xl font-bold">{a.who}</h3>
              <p className="mt-4 flex-1 text-lg leading-relaxed text-orange-100/70">{a.what}</p>
              <Link href={a.href} className="mt-8 inline-flex self-start rounded-xl bg-accent px-6 py-3 text-base font-semibold text-black transition hover:brightness-110">
                {a.cta} →
              </Link>
            </div>
          ))}
          </div>
        </section>

      </div>

      {/* Footer: black & white looping video */}
      <footer className="relative h-[calc(100vh-56px)] min-h-[420px] overflow-hidden bg-black text-[#fff]">
        <LoopVideo className="absolute inset-0 h-full w-full object-cover grayscale" src="/images/footerr.mp4" start={5} end={17} />
        <div aria-hidden className="absolute inset-0 bg-black/30" />
        <div className="relative mx-auto flex h-full max-w-[1500px] flex-col items-center justify-center px-6 py-12 text-center sm:px-12">
          <p className="font-mono text-xs uppercase tracking-[0.35em] text-zinc-300">Built on</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-6">
            {PARTNERS.map((p) => (
              <a key={p.name} href={p.href} target="_blank" rel="noreferrer" className="group flex items-center gap-2">
                <span className="block h-7 w-7 overflow-hidden rounded-md ring-1 ring-white/25 transition group-hover:ring-white/70">
                  <img src={p.logo} alt={`${p.name} logo`} className={`h-full w-full object-cover grayscale transition duration-300 group-hover:grayscale-0 ${p.zoom ?? ""}`} />
                </span>
                <span className="font-heading text-base font-bold">{p.name}</span>
              </a>
            ))}
          </div>
          <p className="mt-4 text-sm text-zinc-300">Canteen × Circle</p>
          <Link href="/arena" className="mt-8 inline-flex rounded-lg bg-accent px-7 py-3 text-base font-semibold text-black transition hover:brightness-110">
            Enter the Arena →
          </Link>
        </div>
      </footer>
    </div>
  );
}
