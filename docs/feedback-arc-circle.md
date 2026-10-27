# Feedback for the Arc and Circle teams

**Feedback for the Arc and Circle teams from the Arena team**

> **One-paragraph summary.** On Arc testnet, a transaction priced below the 20 gwei minimum base fee is **accepted** by `eth_sendRawTransaction` (the node returns a transaction hash and no error), is listed as *pending*, and is **never mined**. Worse, it **blocks every later transaction from the same account**, even correctly priced ones, because of the nonce queue. Nothing reports an error, so an unattended signer — exactly what an AI agent with a wallet is — silently stops working. Arc's own documentation describes this behaviour three different ways. We reproduced it live, built a drop-in client-side fix (`arc-guard`, a doctor CLI and a runnable repro) and propose a small platform-side change that would remove the problem for every developer.

---

## Table of contents

1. [Context: how we found it](#1-context-how-we-found-it)
2. [The problem](#2-the-problem)
3. [Evidence — reproduced live on Arc testnet](#3-evidence--reproduced-live-on-arc-testnet)
4. [The real pain point (root cause)](#4-the-real-pain-point-root-cause)
5. [Why it matters for what the sponsors want to achieve](#5-why-it-matters-for-what-the-sponsors-want-to-achieve)
6. [What could have been done](#6-what-could-have-been-done)
7. [The near-perfect solution](#7-the-near-perfect-solution)
8. [What we built (our fix)](#8-what-we-built-our-fix)
9. [Plan: rollout, owners and acceptance criteria](#9-plan-rollout-owners-and-acceptance-criteria)
10. [How a judge can verify this in 5 minutes](#10-how-a-judge-can-verify-this-in-5-minutes)
11. [Before and after](#11-before-and-after)
12. [Limitations and honest caveats](#12-limitations-and-honest-caveats)
13. [Other findings (smaller)](#13-other-findings-smaller)
14. [Appendix](#14-appendix)

---

## 1. Context: how we found it

Arena puts real USDC behind AI agents on Arc: every agent has a `PolicyWallet`, anyone can pay a fee to attack it, and survival raises its on-chain score and spending limit. Our agents, our gateway's attestor, and our keeper all **sign and send transactions on their own, with nobody watching** — the defining property of an autonomous agent.

While building this we hit the Arc fee floor (documented in [EVM differences](https://docs.arc.io/arc/references/evm-differences) and [Gas and fees](https://docs.arc.io/arc/references/gas-and-fees)) and dug into what actually happens when a transaction goes under it. The behaviour is more dangerous than the docs suggest, and it lands hardest on exactly the kind of builder Arc is courting: agent teams.

---

## 2. The problem

**What a developer expects** (from every other EVM chain): if a transaction cannot be included because the fee is too low, the node says so immediately (`transaction underpriced`) and nothing is left in limbo.

**What Arc does:**

| Step | Behaviour on Arc testnet |
|---|---|
| Submit a signed transaction with `maxFeePerGas` < 20 gwei | `eth_sendRawTransaction` **succeeds and returns a hash** |
| Look it up | `eth_getTransactionByHash` returns it as **pending** (no block number) |
| Ask for a receipt | `null`, forever |
| Submit the *next* transaction with a correct fee at the next nonce | Accepted, but **also never mined** — it waits behind the stuck one |
| Look it up in the block explorer | Its API answers **404 "Not found"** for these hashes (checked after the repair), so there is no page to debug from |
| Client libraries (`waitForTransactionReceipt`, etc.) | Hang until their own timeout, then throw a generic timeout error |

The account is **wedged** until someone replaces the stuck nonce. An autonomous signer that does not know to do that is bricked — silently.

---

## 3. Evidence — reproduced live on Arc testnet

Everything below was run against `https://rpc.testnet.arc.io` (chain id 5042002) from a throwaway funded wallet `0xeff56c6a2d98D0cc70C5151AE0E17bE7961067FB`. Every experiment is repeatable with `pnpm arc:repro` (see [section 10](#10-how-a-judge-can-verify-this-in-5-minutes)).

### 3.1 The node's own numbers are consistent — which makes the failure more surprising

```
eth_gasPrice                 = 0x5d21dba00   = 25 gwei
eth_maxPriorityFeePerGas     = 0x12a05f200   = 5 gwei
latest block baseFeePerGas   = 20 gwei       (and 20 gwei in every one of the last 5 blocks)
```

The chain advertises a price above the floor, so a *well-behaved* client is fine. The danger is any transaction that does not use the node's fee estimate — a hard-coded gas price, a wallet or SDK default, a value copied from another chain's config, a sponsor/relayer service with its own pricing.

### 3.2 Experiments

| # | Experiment (account nonce 0, zero-value self-transfer) | Observed |
|---|---|---|
| E1 | EIP-1559 tx, `maxFee` 10 gwei, **let the tool estimate gas** (`cast send`) | Rejected with `-32000: max fee per gas less than block base fee` — **correct** behaviour, but only on the *gas-estimation* path |
| E2 | **Legacy** tx, `gasPrice` 10 gwei, sent raw | **Accepted, hash returned.** Receipt `null` at +8 s, +16 s, +24 s. `eth_getTransactionByHash` still returns it. Confirmed nonce stays 0; `pending` nonce reads 1 |
| E3 | **EIP-1559** tx, `maxFee` 10 gwei, explicit gas limit (skips estimation) | **Accepted, hash returned.** Not mined; nonce stayed 3 after 10 s |
| E4 | Underpriced tx at nonce 1, then a **correctly priced** (30 gwei) tx at nonce 2 | The 30 gwei tx **also stayed unmined**. Replacing nonce 1 with a 30 gwei tx **immediately released both** (final nonce 3) |
| E5 | `pnpm arc:repro` (scripted E2 + E4 + our fix) | Reproduced again end to end; the fix worked (see [section 8](#8-what-we-built-our-fix)) |
| E6 | **Circle Wallets API** (`contractExecution`) with `feeLevel` LOW and MEDIUM from a disposable wallet (`pnpm exec tsx scripts/circle-fee-probe.ts`) | Both mined within ~3 s (`INITIATED → SENT → COMPLETE`) at on-chain `maxFeePerGas` of **370 gwei** (LOW) and **491 gwei** (MEDIUM) — far above the floor, so Circle's defaults cannot trigger this problem |
| E7 | **Circle Wallets API** with an explicit `maxFee` of 10 gwei (below the floor) | **Rejected at submission:** `400 The provided fee in request is invalid.` — Circle's layer already refuses what Arc's node accepts |

**Key observation (E1 vs E2/E3).** The node *already contains* the check "fee below base fee": it fires during gas estimation. It is simply **not applied when the transaction is admitted to the pool**. That is an inconsistency, not a missing feature — and it is what makes this look like an oversight rather than a design decision.

Transaction hashes (all on testnet; the "stuck" ones were never mined, and the explorer API (`/api/v2/transactions/<hash>`) answers 404 for all three we checked — that is part of the problem):

| What | Hash |
|---|---|
| E2 stuck legacy tx (10 gwei) | `0xe9600af16817ed510de98371fba562547ad95b540a3aba2c30daf25e7e45bce3` |
| E2 repair (30 gwei, same nonce) | [`0x0140d2bc…98fff2`](https://explorer.testnet.arc.io/tx/0x0140d2bcf02fc4dd3b4d86654eab753e3c09ee19c13c02d2bd1a36d04198fff2) |
| E3 stuck EIP-1559 tx | `0x48064ea9c81461e21c68eb860e5d443c8a9f7d518a4b686f34855a83106dfa57` |
| E4 stuck underpriced tx (nonce 1) | `0x123ead6fd7c8dea223fa37144121bfb9a0663377359d64135de8c8f050c36a78` |
| E4 correctly priced tx blocked behind it (nonce 2, mined only after the repair) | `0x25a16bb33fa496c031d9c20086fca5f6ce58da1a2c800281b05252fb7543f854` |
| E5 `arc:repro` repair (nonce 4) | block 67703573 |

### 3.3 The documentation describes this three different ways

| Where | What it says happens to a transaction under 20 gwei |
|---|---|
| [EVM differences](https://docs.arc.io/arc/references/evm-differences) | "**silently dropped** by the mempool. They produce **no error**, no receipt and **never appear in a block**." |
| [Gas and fees — Submitting transactions](https://docs.arc.io/arc/references/gas-and-fees) | "may **remain pending indefinitely** or **fail outright**." |
| [Gas and fees — Common errors](https://docs.arc.io/arc/references/gas-and-fees) | Error **`transaction underpriced`** — "increase `maxFeePerGas` to at least 20 gwei and resubmit" |

What we observed matches none of them exactly: not dropped (the node still lists the tx as pending), not rejected with `transaction underpriced` (that string never appeared; the estimate path says `max fee per gas less than block base fee`), but "pending indefinitely" — **plus the part no page mentions: it blocks the account's later transactions.**

---

## 4. The real pain point (root cause)

Three small design gaps combine into one serious failure:

```
   (1) VALIDATION GAP                    (2) HEAD-OF-LINE BLOCKING            (3) NO SIGNAL
 ┌───────────────────────┐          ┌──────────────────────────────┐      ┌──────────────────────────┐
 │ the fee check exists  │          │ nonces must be mined in order │      │ no error at submit       │
 │ in eth_estimateGas but│   ───▶   │ one unmineable tx at nonce N  │ ───▶ │ no receipt, no explorer  │
 │ NOT at pool admission │          │ stalls N+1, N+2 …             │      │ entry, docs disagree     │
 └───────────────────────┘          └──────────────────────────────┘      └──────────────────────────┘
                                                   │
                                                   ▼
                       an unattended signer retries forever (or gives up) with no way to know why
```

The pain point is **not "the fee floor exists"** — a fee floor is a reasonable, stablecoin-friendly design. It is that **the floor is enforced after the node has already told the client "accepted"**. The contract between a node and its client — *"if I return a hash, your transaction is valid and will be mined once fees allow"* — is broken for this one case.

---

## 5. Why it matters for what the sponsors want to achieve

Circle's and Arc's stated goal is **agents that hold and spend USDC on their own** on Arc: [Agent Wallets with spending policies](https://developers.circle.com/agent-stack/agent-wallets), nanopayments, Paymaster-sponsored gas, developer-controlled wallets that sign contract calls.

| Goal | How this bug works against it |
|---|---|
| **Autonomy** ("no human in the loop") | The one failure that needs a human is a silent wedge. An agent that stops paying invoices without raising any error is worse than one that crashes loudly |
| **Reliability of agent payments** | One wrong fee value from any layer (SDK default, relayer, sponsor, copy-pasted chain config) can freeze a signer that holds real money and obligations |
| **Developer onboarding** | The first thing a new Arc builder does is send a transaction. If a tool picks the wrong fee, they see a hash and then nothing — and three doc pages tell them three different things |
| **Observability / audit** | A transaction that never reaches the chain leaves no on-chain or explorer evidence to debug or audit |
| **Cost of retries** | Agents that retry with the same low fee pile more pending transactions into the stuck queue |

For **Circle Wallets** we measured it (E6, E7 above) and the result is reassuring and instructive: the developer-controlled wallets API either uses fees far above the floor (LOW and MEDIUM mined at 370 and 491 gwei max fee) or **rejects a below-floor fee up front** (`400 The provided fee in request is invalid`). So agents signing through Circle Wallets are protected — and that is exactly the argument for Layer 1: **Circle's API already validates the fee at submission; Arc's own node, which every other signer talks to directly, does not.** One small improvement even there: the Circle error does not say *why* the fee is invalid (it never mentions the 20 gwei floor), so a developer has to find the floor in the docs. (We verified an end-to-end production payment signed by a Circle wallet, see [section 8](#8-what-we-built-our-fix).)

---

## 6. What could have been done

| Option | Where | What it does | Verdict |
|---|---|---|---|
| **A. Reject at admission** | Arc node / txpool | `eth_sendRawTransaction` returns `-32000 transaction underpriced` (with the floor in the error data) for fees below the floor | **Best.** Smallest change, matches Ethereum behaviour and the docs' own "Common errors" table |
| **B. Make the stuck state visible** | Arc RPC | Return a standard "dropped/underpriced" status through `eth_getTransactionReceipt` or a pool-status call, and show pending/dropped transactions in the explorer | Good complement: a debugging aid when A is not enough |
| **C. Evict instead of hold** | Txpool | Drop sub-floor transactions *and* remove them from the account's queue so later nonces are not blocked | Fixes the blocking even without client changes |
| **D. Reconcile the docs** | docs.arc.io | One page, one behaviour, one error string, one repair recipe (replace-by-fee) | Cheap, immediate, necessary whatever else happens |
| **E. Client guard** | Wallets / SDKs / our repo | Never sign under the live floor; use the confirmed nonce; bounded wait + automatic replace-by-fee | **What we built** — works today, no platform change needed |
| **F. Chain config in popular libraries** | viem / ethers chain definitions | Ship Arc's fee floor as the default `fees.estimateFeesPerGas` | Prevents the most common way to hit this (we ship it in `packages/shared/src/chain.ts`) |

---

## 7. The near-perfect solution

**Two layers, so the fix works today *and* the problem disappears permanently.**

### Layer 1 — Platform (the proper fix; small)

Apply the existing base-fee check at pool admission and return a precise, machine-readable error:

```
POST eth_sendRawTransaction   (maxFeePerGas = 10 gwei)

BEFORE  → { "result": "0xe9600af1…bce3" }                       ← accepted, never mined
AFTER   → { "error": { "code": -32000,
                       "message": "transaction underpriced",
                       "data": { "maxFeePerGas": "0x2540be400",
                                 "minBaseFee":   "0x4a817c800",
                                 "hint": "set maxFeePerGas >= minBaseFee, or replace the nonce with a higher fee" } } }
```

This is the same check Circle's wallet API already performs (E7), so it is proven, cheap and consistent with how the rest of the stack behaves.

Plus (nice to have): evict any already-pooled sub-floor transaction and release the account's queue; expose the dropped state; fix the three contradictory doc passages into one.

### Layer 2 — Ecosystem (works now): `arc-guard`

For every signer that sends transactions unattended:

1. **Read the floor from the chain** (latest block base fee), never hard-code it.
2. **Refuse to sign** a transaction under the floor, with a typed error (`ArcUnderpricedError`).
3. **Use the confirmed nonce**, not the pool's "pending" nonce, so one stuck transaction cannot poison the next.
4. **Bounded wait, then replace-by-fee** automatically (+25% per attempt) on the same nonce.
5. **A doctor** that detects a wedged account and repairs it with one command.

Layer 1 removes the cause; Layer 2 protects every client in the meantime and remains good defence-in-depth (a signer should still never trust "accepted").

---

## 8. What we built (our fix)

All code is in this repository and has been exercised live on Arc testnet.

| File | What it is |
|---|---|
| [`packages/shared/src/arc-guard.ts`](packages/shared/src/arc-guard.ts) | The library: `arcFloor`, `guardFee`, `ArcUnderpricedError`, `diagnose`, `unwedge`, `sendArcTx` (exported from `@arena/shared`) |
| [`scripts/arc-underpriced-repro.ts`](scripts/arc-underpriced-repro.ts) | One command that reproduces the bug, then demonstrates every part of the fix (`pnpm arc:repro`) |
| [`scripts/arc-doctor.ts`](scripts/arc-doctor.ts) | CLI: report an account's mined vs pending nonce and the floor; `--fix` replaces the stuck nonce (`pnpm arc:doctor`) |
| [`scripts/circle-fee-probe.ts`](scripts/circle-fee-probe.ts) | The Circle Wallets experiment (E6, E7) on a disposable wallet |
| [`scripts/circle-proof.ts`](scripts/circle-proof.ts) | Proof that a Circle-signed contract call lands on Arc testnet |
| [`packages/shared/src/chain.ts`](packages/shared/src/chain.ts) | Arc chain definitions with a fee estimator that never goes below the floor (already in use by our agents, gateway and keeper) |

**API in one glance**

```ts
import { guardFee, sendArcTx, diagnose, unwedge, ArcUnderpricedError } from "@arena/shared";

await guardFee(publicClient, { maxFeePerGas });            // throws ArcUnderpricedError if under the live floor
const { receipt, attempts } = await sendArcTx(wallet, publicClient, { to, data });  // guard + confirmed nonce + auto-bump
const d = await diagnose(publicClient, address);           // { confirmedNonce, pendingNonce, floor, hasPendingTxs }
await unwedge(wallet, publicClient);                       // replace the stuck nonce (replace-by-fee)
```

**Result of `pnpm arc:repro` on Arc testnet (real output):**

```
1) The RPC accepts a transaction priced at 10 gwei (below the 20 gwei floor):
   ✓ eth_sendRawTransaction returned a hash, no error: 0x9a1de7f6…7816
2) ...but it is never mined. Waiting 20 s:
   receipt: none · node still lists it: yes, pending
3) A correctly priced transaction at the NEXT nonce is blocked behind it:
   30 gwei tx at nonce 5: still unmined — the account is wedged
4) The fix, part 1 — guardFee refuses to send under the floor:
   ✓ ArcUnderpricedError: maxFeePerGas 10 gwei is below Arc's minimum base fee of 20 gwei
5) The fix, part 2 — unwedge replaces the stuck nonce (replace-by-fee):
   ✓ nonce 4 replaced in block 67703573; later tx now mined; mined nonce 6
6) The fix, part 3 — sendArcTx does guard + confirmed nonce + bounded wait + auto-bump:
   ✓ mined in 1 attempt(s): 0x8fb362013adf…dadc4
```

---

## 9. Plan: rollout, owners and acceptance criteria

| Phase | Work | Owner | Acceptance criteria |
|---|---|---|---|
| **0. Done (this hackathon)** | Reproduce, document, ship `arc-guard` + doctor + repro; Arc fee estimator in our chain config | Arena | `pnpm arc:repro` passes on testnet; typecheck clean |
| **1. Docs (days)** | Replace the three contradictory passages with one statement of the real behaviour and a "stuck transaction" recipe (replace-by-fee); add the nonce-blocking warning | Arc docs | One consistent description; recipe tested |
| **2. Platform admission check (small PR)** | Apply the base-fee check in `eth_sendRawTransaction` and return `-32000 transaction underpriced` with `data.minBaseFee` | Arc node team | Re-running experiments E2/E3 returns an error and leaves no pending tx; E1 behaviour unchanged |
| **3. Visibility** | Surface pending/dropped transactions in the explorer and via an RPC status call | Arc explorer / RPC | A sub-floor transaction is findable by hash with a clear status |
| **4. Wallet products** | Keep the existing fee validation (it works, E7); make the error name the floor (`maxFee 10 gwei < Arc minimum 20 gwei`); add automatic replace-by-fee if a transaction ever reaches `STUCK` on Arc | Circle Wallets | The error message states the floor; a `STUCK` transaction self-heals without developer action |
| **5. Libraries** | Ship the Arc floor in viem/ethers chain definitions and templates | Circle devrel | New projects get a safe default fee estimator |

**Risks:** replace-by-fee needs ≥10% fee bump (we use +25%); sending two transactions for one account at once shares a nonce (our helper documents this); the floor may change before mainnet (we read it from the chain instead of hard-coding it).

---

## 10. How a judge can verify this in 5 minutes

**No setup (read-only, 1 minute):**

```bash
RPC=https://rpc.testnet.arc.io
# the chain advertises a price above the floor...
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}'
# ...and the floor itself is the base fee of every block
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' | grep -o '"baseFeePerGas":"[^"]*"'
```

**Full reproduction (needs a throwaway wallet with ≥ $0.01 testnet USDC from https://faucet.circle.com):**

```bash
git clone <repository-url> && cd arena && pnpm install
REPRO_KEY=0x<throwaway testnet key> pnpm arc:repro
```

It prints the six steps shown in [section 8](#8-what-we-built-our-fix) and leaves the account repaired. To inspect any account: `pnpm arc:doctor 0xAddress`.

**By hand with Foundry (the same bug, two commands):**

```bash
cast send $ME --value 0 --private-key $KEY --rpc-url $RPC --legacy --gas-price 10gwei --async   # returns a hash...
cast receipt <hash> --rpc-url $RPC                                                                # ...that never gets a receipt
```

---

## 11. Before and after

| | Before (default tooling on Arc) | After (`arc-guard`, and Layer 1 if adopted) |
|---|---|---|
| Sub-floor transaction | Accepted, hash returned, never mined | Refused locally with `ArcUnderpricedError` (client) / `transaction underpriced` (node, Layer 1) |
| Later transactions on that account | Silently blocked | Not affected: confirmed nonce is used, stuck nonces are replaced |
| Signals available to an unattended agent | None (a generic timeout at best) | Typed error, `diagnose()` report, automatic repair |
| Time to recover | Unbounded; needs a human who knows about replace-by-fee | Seconds, automatic |
| Evidence trail | None: not on the chain, not in the explorer | Error is explicit; the replacement transaction is on-chain |
| Documentation | Three conflicting descriptions | One (proposed) |

---

## 12. Limitations and honest caveats

- **Our fix is client-side.** It protects the code that uses it; only Layer 1 protects every developer. We are proposing Layer 1, not claiming to have shipped it.
- **Automatic fee-bump path:** `sendArcTx` guards, uses the confirmed nonce and waits; its bump-and-resend loop is implemented but we did not trigger it live (a correctly priced Arc transaction mines within one block, so we could not make it time out on purpose). Guard, nonce handling, `diagnose` and `unwedge` were all exercised live.
- **Concurrency:** `sendArcTx` reads the confirmed nonce, so two simultaneous calls from one account would share it. Callers need a per-account send queue.
- **Nonce visibility is inconsistent:** in one run the node's `pending` nonce counted the stuck transaction (1 vs 0 mined), in another it did not. We therefore do not rely on the pending/confirmed gap to *detect* a wedge — `unwedge` is safe to run unconditionally (worst case it sends one harmless ~$0.0005 self-transfer).
- **Circle Wallets:** measured with a *test* API key on testnet only (E6, E7 and a live production payment). **Paymaster / Gas Station** were not tested, so nothing in this report is a claim about them.
- **Testnet only:** the floor is documented as a testnet parameter that "may change before mainnet"; we read it from the chain.
- **Not reproduced (so not claimed):** we also tried to provoke RPC rate limiting with 120 parallel light calls to the public RPC and got 120 × HTTP 200. Earlier we did see throttling under sustained `eth_getLogs` polling from our indexer, but we did not measure it rigorously, so it is not part of this report.

---

## 13. Other findings (smaller)

These are real friction points we hit and verified, listed in order of how much they cost us. None is the headline, but each is cheap to fix.

1. **Forking Arc with stock Foundry gives an unhelpful empty revert.** On `anvil --fork-url https://rpc.testnet.arc.io`, `USDC.balanceOf(...)` works but `USDC.transfer(...)` fails with `execution reverted, data: "0x"` (no reason), while a native value transfer succeeds. The ERC-20 interface at `0x3600…0000` depends on an Arc-native precompile that stock anvil does not have. Arc ships **Arc Foundry** for this ([install guide](https://docs.arc.io/arc/tutorials/install-arc-foundry)), but that guide offers Linux, Apple-silicon macOS or **Windows via WSL** only — a native-Windows developer is left with an opaque empty revert. *Suggestion:* have the stock-Foundry failure point at Arc Foundry (or ship a ready-made Arc-aware test token for `vm.etch`). We worked around it with a labelled 6-decimal test token for local runs.
2. **One USDC balance with two decimal systems** (18 native, 6 via the ERC-20 interface; `balanceOf` truncates dust). Documented, but easy to get wrong by ×10¹²; we only ever do accounting in the 6-decimal interface and never use `msg.value`.
3. **Two public domains in circulation** (`rpc.testnet.arc.io` / `explorer.testnet.arc.io` versus the older `rpc.testnet.arc.network` / `testnet.arcscan.app`). Both answer today, and projects in the wild use either (we saw the older one on an ecosystem site we inspected); one canonical set in all docs and chain registries would remove a source of confusion.
4. **Faucet size versus a realistic deployment.** Our seed script wants roughly $60 of testnet USDC to deploy seven contracts and fund three agents with real bounties; we ended up running with about $32 in the deployer wallet and had to scale the tier bounties down to fit. A higher developer allowance for builders would let serious projects test at realistic sizes.

5. **Circle Paymaster documentation contradicts itself about Arc.** The [Paymaster overview](https://developers.circle.com/paymaster) lists its supported chains as Arbitrum and Base (ERC-4337 v0.7) and Arbitrum, Avalanche, Base, Ethereum, Optimism, Polygon and Unichain (v0.8) — **no Arc** — while the [2025-10-27 release notes](https://developers.circle.com/release-notes/w3s-2025) say "Expanded Paymaster support to include Arc testnet". We could not tell from the docs whether Paymaster works on Arc, which blocked a PRD item. A related design question: on Arc gas is *already* USDC, so a paymaster whose headline feature is "pay gas fees with USDC" has little to add there; the useful Arc feature is *sponsored* gas (Gas Station), which needs ERC-4337 smart accounts rather than the injected wallets most attackers use. A short "what Paymaster / Gas Station mean on Arc" page would save the next builder an afternoon.

6. **Circle Gateway Nanopayments (x402) — the seller quickstart's testnet example fails as written.** The [seller quickstart](https://developers.circle.com/gateway/nanopayments/quickstarts/seller) shows `createGatewayMiddleware({ sellerAddress, networks: ["eip155:5042002"] })` ("Only accept Arc Testnet"). With that code, an unpaid request to a protected route returns **`503 {"error":"No payment networks available"}`**: the default facilitator is Gateway **mainnet** (we listed its supported kinds: only mainnet chains such as `eip155:5042` for Arc mainnet), and the testnet endpoint (`https://gateway-api-testnet.circle.com`) has to be passed as `facilitatorUrl`, which is mentioned only in the SDK type comment. After setting it, the same route returns a correct `402` and the full flow works (we ran it live). Three smaller papercuts on the way: `GatewayClient.pay` adds its own `content-type`, so a caller who also passes `content-type: application/json` sends `application/json, application/json`, which strict servers (Fastify) reject with 415 on the paid retry; a fresh Gateway deposit is not spendable for a moment, so an immediate `pay` fails with a generic "Payment settlement failed" (there is no "deposit still pending" signal); the package's `@x402/evm` and `@x402/core` peer dependencies are not installed automatically by pnpm (`ERR_MODULE_NOT_FOUND` at start-up), and Gateway reports the payer address lower-cased, so a strict checksum comparison against a session owner fails unless it is normalised. *Suggestion:* make the testnet/mainnet choice follow the requested `networks`, or put `facilitatorUrl` in the quickstart snippet.
7. **The Gateway buyer client's default Arc RPC.** `GatewayClient({ chain: "arcTestnet" })` used `https://rpc.testnet.arc.network/` for its balance read, and that call failed once with `fetch failed` while `rpc.testnet.arc.io` was healthy at the same time (we observed it once, so we only note it). Passing `rpcUrl` fixed it; defaulting to the current `.io` endpoint would remove the dependency on the older domain.

8. **Circle Contracts API: a generic error and a large up-front fee reservation.** (a) A deployment request with the name `Arena GrantPool (Circle Contracts demo)` and a description containing an apostrophe was rejected with `400 API parameter invalid` and no field named; the same request with a plain name and description worked, so a validation rule on those text fields exists but is not reported. (b) With the `MEDIUM` fee level Circle reserves roughly **$0.38** of native token for one contract deployment (`INSUFFICIENT_NATIVE_TOKEN … Total pending fee: 0.382…, usable wallet balance: 0.0708`), because the reservation is max fee × gas limit (we saw 370–491 gwei max fees in E6) on a chain where the real cost is a small fraction of that. A wallet with a few cents can therefore not deploy anything. Reserving against the node's actual `baseFee` (20 gwei on Arc testnet) plus a margin would let small wallets work.

---

## 14. Appendix

**Sources (Arc documentation)**
- EVM differences: https://docs.arc.io/arc/references/evm-differences
- Gas and fees: https://docs.arc.io/arc/references/gas-and-fees
- Install Arc Foundry: https://docs.arc.io/arc/tutorials/install-arc-foundry

**Environment of the experiments:** Arc testnet (chain id 5042002), public RPC `https://rpc.testnet.arc.io`, Foundry (nightly) `cast`/`anvil`, viem for the scripts, run on 2026-10-17.

**Where this repository already applies the lessons:** the Arc chain definition and fee floor in [`packages/shared/src/chain.ts`](packages/shared/src/chain.ts), bounded receipt waits (`RECEIPT_TIMEOUT_MS`) in every signer, and the RPC fallback transport in [`packages/shared/src/node.ts`](packages/shared/src/node.ts).

**Contact:** the Arena team, through the repository's issue tracker.
