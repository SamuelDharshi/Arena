# Feedback for the sponsors: NVIDIA, Zetaris and Meterless

**From the Arena team, written after building Sentinel-05, the attack memory and the payee evidence in one build day.**

> **In one sentence:** the same pain point showed up in two sponsors' APIs. *A builder cannot find out why something they are allowed to see is not usable.* NVIDIA lists models that a key cannot call. Zetaris answers a made-up key, a wrong org and a real key with the same `400 Not Allowed`. Both are cheap to fix, and both cost us real debugging time. We built the diagnostics the APIs should have, and describe below the small API change that would make them unnecessary.

## Contents
1. [Summary](#1-summary)
2. [How we ran into it](#2-how-we-ran-into-it)
3. [Finding 1: NVIDIA lists models a key cannot use](#3-finding-1-nvidia-lists-models-a-key-cannot-use)
4. [Finding 2: Zetaris cannot tell you which credential is wrong](#4-finding-2-zetaris-cannot-tell-you-which-credential-is-wrong)
5. [The real pain point](#5-the-real-pain-point)
6. [What could have been done: the near-perfect solution](#6-what-could-have-been-done-the-near-perfect-solution)
7. [The fix we are providing](#7-the-fix-we-are-providing)
8. [Smaller findings](#8-smaller-findings)
9. [How a judge can verify this in five minutes](#9-how-a-judge-can-verify-this-in-five-minutes)
10. [Priorities](#10-priorities)

---

## 1. Summary

| | NVIDIA Nemotron API | Zetaris SQL Query API |
|---|---|---|
| **What happens** | `GET /v1/models` lists 10 Nemotron chat models. With our key, **6 of them fail** with `404 Function '…': Not found for account '…'` | Our key and org, a **made-up key** and a **wrong org** all get `400 {"msg":"Not Allowed"}` |
| **What the builder needs to know** | "This model is not enabled for you, and here is how to enable it" | "Which of key, org or entitlement is wrong" |
| **What the builder gets** | A function UUID and an account id | Two words |
| **Cost** | We picked a default model that 404'd, and found out in the first live call | A day-one blocker on the sponsor track; we could not tell our fault from theirs |
| **Fix size** | One field on the models list and one error code | Three distinct error codes and a `whoami` call |

## 2. How we ran into it

Arena is a live-fire range where anyone can try to trick an AI payment agent into paying them. For this build we added:

- **Sentinel-05**, a new agent that reasons on **NVIDIA Nemotron**;
- an **attack memory** that follows the **Meterless H-MEM** design;
- **payee evidence** as one federated query through **Zetaris**.

Each integration was written from the sponsor's documentation, then run for real. Everything below is what the real runs showed. The two reproduction scripts are in the repository ([section 9](#9-how-a-judge-can-verify-this-in-five-minutes)).

## 3. Finding 1: NVIDIA lists models a key cannot use

**What we did.** We read the model list from NVIDIA's public endpoint and picked a current Nemotron model (`nvidia/nemotron-3-super-120b-a12b`) as the default. The key itself was valid: `GET /v1/models` with it returned the full list.

**What happened.** The first chat request returned:

```json
{"status":404,"title":"Not Found","detail":"Function 'ac74040f-9fc9-4c5e-ac74-279ba5161d69': Not found for account 'ucfO…'"}
```

**What we found by probing every listed Nemotron chat model with the same key:**

| Result | Models |
|---|---|
| usable (4) | `nemotron-3-ultra-550b-a55b`, `nemotron-3-nano-omni-30b-a3b-reasoning`, `nemotron-3.5-bolt-e4b`, `nemotron-3.5-lightning-30b-a3b` |
| **blocked (6)** | `nemotron-3-super-120b-a12b`, `nemotron-nano-3-30b-a3b`, `nemotron-4-340b-instruct`, `llama-3.1-nemotron-ultra-253b-v1`, `llama-3.1-nemotron-70b-instruct`, `llama-3.1-nemotron-51b-instruct` |

The catalog the key can read is not the set of models the key can call, and nothing in the response says so. The error uses a status (`404`, "Not Found") that reads as "wrong URL or wrong model name", which sends the builder to check spelling. It carries an internal function id, and no pointer to where the model is enabled.

## 4. Finding 2: Zetaris cannot tell you which credential is wrong

**What we did.** We followed the API guide: org id, API key as the Bearer token, `X-Org-ID` and `X-Request-ID` headers. We implemented the SQL Query API (start, page, close) from the OpenAPI file.

**What happened.** Every authenticated call returned `400 {"msg":"Not Allowed"}`, even a plain database listing. To find out whose fault it was we sent the same harmless request with different credentials:

| Request | Answer |
|---|---|
| no `Authorization` header | `401 Invalid value for: header Authorization (missing)` |
| no `X-Org-ID` header | `400 Invalid value for: header X-Org-ID (missing)` |
| **our API key + our org** | **`400 {"msg":"Not Allowed"}`** |
| **our API key + a wrong org (999999)** | **`400 {"msg":"Not Allowed"}`** |
| **a made-up key + our org** | **`400 {"msg":"Not Allowed"}`** |

The API reports *format* problems precisely and collapses *every* credential problem into one message. We could not tell whether the key was wrong, the org was wrong, API access was not enabled for the org, or we had misread the guide.

The guide made this harder: the login endpoint uses Basic auth, the refresh endpoint a JWT Bearer, and the SQL endpoints "an API token via Bearer". Those are three meanings of "Bearer" in one spec. They are only distinguishable in the OpenAPI file, which is not linked from the guide (the Redoc page loads `./docs.yaml`).

## 5. The real pain point

The two findings have one cause, and it is not a bug in either product. **The catalog and the entitlement live in different places, and the API never joins them for the caller.**

- NVIDIA's list answers "what exists". Whether *this key* may call it is decided later, deep in the serving layer, and surfaces as a generic not-found.
- Zetaris's authentication answers "allowed or not", and stops. It does not say *which* check failed, because a single message is the easy way to avoid leaking whether an org or key exists.

Collapsing errors is a sound security habit for **unauthenticated** callers. Here the caller is **authenticated with a key the system recognises or can look up**: telling that caller which of their own entitlements is missing leaks nothing. The cost of staying silent is paid by exactly the people the platforms are trying to win: builders on a deadline who, with a clear error, would have moved on in two minutes.

## 6. What could have been done: the near-perfect solution

**NVIDIA.** Four small changes, none of which exposes anything the key holder should not know:

1. **Make the list entitlement-aware.** Add a `usable` field per model for the calling key (or `GET /v1/models?usable=true`).
2. **Return a typed error for a model the key cannot call**, and say how to fix it:
   ```json
   { "error": { "code": "model_not_enabled", "status": 403,
                "message": "nvidia/nemotron-3-super-120b-a12b is not enabled for this key.",
                "action": "https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b → Get API access" } }
   ```
3. **Document the reasoning switch.** Nemotron reasons before it answers unless told not to (`chat_template_kwargs: {"enable_thinking": false}`); that parameter, its default and its cost belong on the model page.
4. **Count reasoning tokens separately** in `usage`, so a `finish_reason: "length"` caused by thinking is distinguishable from a long answer (see [section 8](#8-smaller-findings)).

**Zetaris.** Three changes:

1. **Distinct credential errors.** `401 invalid_api_key`, `403 org_mismatch`, `403 api_access_not_enabled`, each with one line saying what to check.
2. **A `GET /api/v1.0/auth/whoami`** that returns the org, the user or key id and the scopes for the credentials sent. One call tells a builder whether they are "in".
3. **Link the OpenAPI file from the guide**, say which token each endpoint family expects, and state the SQL dialect and how federated catalogs are named. Our federated query is written in portable SQL because the dialect is not documented.

**Meterless.** Publish the memory interface as a package or a hosted endpoint with a `remember` and a `recall` call. We found no public SDK, and a third-party review describes the open repository as a minimal reference implementation rather than a drop-in SDK. Our `MemoryBackend` interface (`packages/memory/src/types.ts`) is a candidate contract, and an H-MEM adapter would replace our implementation without touching the agents.

## 7. The fix we are providing

We built the diagnostics the APIs should have. They are small, they run in seconds, and they are usable by any builder on these platforms.

| Tool | What it does | Run it |
|---|---|---|
| `scripts/nvidia-models.ts` | Probes every listed Nemotron chat model with **your** key and prints which ones are usable, with latency, and the `NVIDIA_MODEL` to set | `pnpm exec tsx scripts/nvidia-models.ts` |
| `scripts/zetaris-diagnose.ts` | Sends the same request with your credentials, a wrong org and a made-up key, and tells you whether the API can tell them apart | `pnpm exec tsx scripts/zetaris-diagnose.ts` |
| `apps/agents/src/llm.ts` (`nvidia()`) | A Nemotron client that asks for a strict JSON schema, falls back to JSON mode if rejected, validates every answer locally, switches thinking off by default, and **fails safe**: any error makes the agent hold, never pay | used by Sentinel-05 |
| `scripts/llm-check.ts` | Validates the key, checks the configured model is listed, and asks it for one real decision | `LLM_PROVIDER=nvidia pnpm exec tsx scripts/llm-check.ts` |

We also made the platform's weak spots **safe by default in the product**: when Zetaris is unreachable or refuses, the payee lookup falls back to the arena's own ledger, and the decision log labels the source `ledger`, never `zetaris`. A refused credential degrades a feature, it does not block a payment decision or hide where the evidence came from.

## 8. Smaller findings

| Area | Finding | What helped |
|---|---|---|
| **NVIDIA reasoning cost** | With thinking on, a tiny prompt took 6.3 s (322 tokens) and a full structured decision about 45 s; with thinking off the same tiny prompt took 1.1 s (6 tokens). On `nemotron-3.5-lightning-30b-a3b` a 600-token limit was used up before any answer (`finish_reason: length`). A payment decision makes several model calls, so 45 s per call is unusable in a chat | `enable_thinking: false` by default, `NVIDIA_THINKING=on` to opt in |
| **NVIDIA structured output** | Strict `json_schema` worked on the usable models. We still keep a JSON-mode fallback and local validation, because one run returned a truncated answer | local schema validation |
| **Zetaris API shape** | The SQL flow (start, page, close) is clear and well specified once you have the OpenAPI file | implemented as written |
| **Meterless** | No hosted endpoint found; we built the H-MEM *shape* (tiers, provenance, confidence, audit ledger) ourselves | `packages/memory` |
| **Our own bug, worth knowing** | An audit ledger hash over JSON broke when records round-tripped through Postgres JSONB, which reorders object keys. Hashing canonical (key-sorted) JSON fixed it. Any memory layer that chains hashes over JSON and stores it in JSONB will hit this | `canonical()` in `packages/memory` |

## 9. How a judge can verify this in five minutes

```bash
pnpm install
# put your own keys in .env (NVIDIA_API_KEY, ZETARIS_ORG_ID, ZETARIS_API_KEY), then:
pnpm exec tsx scripts/nvidia-models.ts        # which listed Nemotron models does MY key actually have?
pnpm exec tsx scripts/zetaris-diagnose.ts     # can Zetaris tell my key from a made-up one?
pnpm selftest                                 # memory, evidence rules, the NVIDIA call path (no network or keys needed)
```

`nvidia-models.ts` prints a table of `usable` and `BLOCKED` models for the key you run it with. `zetaris-diagnose.ts` prints the five-row comparison from [section 4](#4-finding-2-zetaris-cannot-tell-you-which-credential-is-wrong) and says plainly whether your credentials are answered differently from a fake key.

## 10. Priorities

| Change | Who | Effort | Builder time saved |
|---|---|---|---|
| `usable` flag on the models list, plus a typed `model_not_enabled` error | NVIDIA | small | minutes to a first working call, for every new key |
| Distinct credential errors and a `whoami` endpoint | Zetaris | small | the difference between "blocked" and "fixed it in two minutes" |
| Link the OpenAPI file and document the SQL dialect and token types | Zetaris | trivial | removes the guesswork behind the SQL we wrote |
| Document the reasoning switch and report reasoning tokens | NVIDIA | trivial | avoids 45-second calls and truncated answers |
| Publish the memory interface as an SDK or hosted endpoint | Meterless | medium | lets builders adopt H-MEM instead of rebuilding it |

*Earlier feedback on the Arc fee floor and Circle wallets is in [docs/feedback-arc-circle.md](docs/feedback-arc-circle.md).*
