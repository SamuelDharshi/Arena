import Anthropic from "@anthropic-ai/sdk";
import "@arena/shared/node"; // loads .env before the clients read credentials
import { MODEL, PROVIDER, type Provider } from "./definitions";
import { extractJson, validateAgainstSchema } from "./schema";

export type Effort = "low" | "medium" | "high";

export type StructuredResult<T> =
  | { ok: true; data: T; model: string }
  | { ok: false; reason: string };

interface StructuredOpts {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  effort?: Effort;
  maxTokens?: number;
  /** A pipeline that runs on its own model (Sentinel-05). Defaults to the global PROVIDER/MODEL. */
  provider?: Provider;
  model?: string;
}

/**
 * One structured-output call to the configured provider.
 *   PROVIDER=groq      → Groq OpenAI-compatible chat completions with strict json_schema output (GROQ_API_KEY)
 *   PROVIDER=anthropic → Claude structured outputs (ANTHROPIC_API_KEY)
 *   PROVIDER=nvidia    → NVIDIA Nemotron through the OpenAI-compatible API (NVIDIA_API_KEY)
 * Replay determinism comes from the Gauntlet's 3-run rule rather than from sampling settings.
 */
export function structured<T>(opts: StructuredOpts): Promise<StructuredResult<T>> {
  if (testImpl) return testImpl(opts) as Promise<StructuredResult<T>>;
  const provider = opts.provider ?? PROVIDER;
  const model = opts.model ?? MODEL;
  return provider === "groq" ? groq<T>(opts, model) : provider === "nvidia" ? nvidia<T>(opts, model) : claude<T>(opts, model);
}

let testImpl: ((o: StructuredOpts) => Promise<StructuredResult<unknown>>) | null = null;
/** Self-tests replace the model call; pass null to restore it. */
export function __setStructuredForTest(fn: typeof testImpl) {
  testImpl = fn;
}

// ───────────────────────────── Groq ─────────────────────────────

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function groq<T>(opts: StructuredOpts, model: string): Promise<StructuredResult<T>> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, reason: "GROQ_API_KEY not set" };
  const payload = JSON.stringify({
    model,
    temperature: 0,
    max_completion_tokens: opts.maxTokens ?? 1500,
    ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: opts.effort ?? "low" } : {}),
    response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: opts.schema } },
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });
  // Free-tier keys have a tokens-per-minute budget: wait out 429s (Retry-After) a few times before failing safe.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 && attempt < 3) {
        const wait = Math.min(30, Number(res.headers.get("retry-after")) || 5 * (attempt + 1));
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        model?: string;
        error?: { message?: string };
      };
      if (!res.ok) {
        const reason = res.status === 429 ? "LLM rate limited" : `LLM API error ${res.status}: ${body.error?.message ?? res.statusText}`;
        return { ok: false, reason };
      }
      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") return { ok: false, reason: "model output truncated (max tokens)" };
      const text = choice?.message?.content;
      if (!text) return { ok: false, reason: "LLM returned an empty response" };
      return { ok: true, data: JSON.parse(text) as T, model: body.model ?? model };
    } catch (err) {
      if (err instanceof SyntaxError) return { ok: false, reason: "LLM returned invalid JSON" };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, reason: "LLM rate limited" };
}

// ───────────────────────────── NVIDIA Nemotron ─────────────────────────────

const nvidiaUrl = () => `${(process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "")}/chat/completions`;

/**
 * NVIDIA's API is OpenAI-compatible. We ask for a strict json_schema first; if the model or endpoint rejects it we retry
 * with plain JSON mode and put the schema in the system prompt. Either way the answer is validated against the schema
 * here, and anything that does not validate fails safe (the pipeline holds, it never pays).
 */
async function nvidia<T>(opts: StructuredOpts, model: string): Promise<StructuredResult<T>> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) return { ok: false, reason: "NVIDIA_API_KEY not set" };

  const call = async (mode: "json_schema" | "json_object") => {
    const system =
      mode === "json_object"
        ? `${opts.system}

Respond with ONE JSON object only, no prose and no code fences, that matches this JSON schema:
${JSON.stringify(opts.schema)}`
        : opts.system;
    const payload = JSON.stringify({
      model,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 3000,
      // Nemotron reasons before answering (about 45 s per call); a decision makes several calls, so thinking is off unless NVIDIA_THINKING=on.
      chat_template_kwargs: { enable_thinking: process.env.NVIDIA_THINKING === "on" },
      response_format:
        mode === "json_schema"
          ? { type: "json_schema", json_schema: { name: "decision", strict: true, schema: opts.schema } }
          : { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: opts.user },
      ],
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(nvidiaUrl(), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: payload,
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 429 && attempt < 3) {
        const wait = Math.min(30, Number(res.headers.get("retry-after")) || 5 * (attempt + 1));
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
        model?: string;
        error?: { message?: string };
        detail?: string;
      };
      return { res, body };
    }
    throw new Error("rate limited");
  };

  try {
    let { res, body } = await call("json_schema");
    if (res.status === 400 || res.status === 422) {
      // The endpoint did not accept the strict schema: fall back to JSON mode with the schema in the prompt.
      ({ res, body } = await call("json_object"));
    }
    if (!res.ok) {
      const reason = res.status === 429 ? "LLM rate limited" : `LLM API error ${res.status}: ${body.error?.message ?? body.detail ?? res.statusText}`;
      return { ok: false, reason };
    }
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length") return { ok: false, reason: "model output truncated (max tokens)" };
    const text = choice?.message?.content;
    if (!text) return { ok: false, reason: "LLM returned an empty response" };
    const data = extractJson(text);
    const problem = validateAgainstSchema(opts.schema, data);
    if (problem) return { ok: false, reason: `LLM answer failed schema validation (${problem})` };
    return { ok: true, data: data as T, model: body.model ?? model };
  } catch (err) {
    if (err instanceof SyntaxError) return { ok: false, reason: "LLM returned invalid JSON" };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ───────────────────────────── Claude ─────────────────────────────

let _client: Anthropic | null = null;
const client = () => (_client ??= new Anthropic());

async function claude<T>(opts: StructuredOpts, model: string): Promise<StructuredResult<T>> {
  try {
    const res = await client().beta.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: opts.system,
      output_config: { effort: opts.effort ?? "low", format: { type: "json_schema", schema: opts.schema } },
      messages: [{ role: "user", content: opts.user }],
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);

    if (res.stop_reason === "refusal") return { ok: false, reason: "model declined the request (refusal)" };
    if (res.stop_reason === "max_tokens") return { ok: false, reason: "model output truncated (max_tokens)" };
    const text = res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { ok: true, data: JSON.parse(text) as T, model: res.model };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return { ok: false, reason: "LLM rate limited" };
    if (err instanceof Anthropic.APIError) return { ok: false, reason: `LLM API error ${err.status}: ${err.message}` };
    if (err instanceof SyntaxError) return { ok: false, reason: "LLM returned invalid JSON" };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
