import Anthropic from "@anthropic-ai/sdk";
import "@arena/shared/node"; // loads .env before the clients read credentials
import { MODEL, PROVIDER } from "./definitions";

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
}

/**
 * One structured-output call to the configured provider.
 *   PROVIDER=groq      → Groq OpenAI-compatible chat completions with strict json_schema output (GROQ_API_KEY)
 *   PROVIDER=anthropic → Claude structured outputs (ANTHROPIC_API_KEY)
 * Replay determinism comes from the Gauntlet's 3-run rule rather than from sampling settings.
 */
export function structured<T>(opts: StructuredOpts): Promise<StructuredResult<T>> {
  return PROVIDER === "groq" ? groq<T>(opts) : claude<T>(opts);
}

// ───────────────────────────── Groq ─────────────────────────────

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function groq<T>(opts: StructuredOpts): Promise<StructuredResult<T>> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, reason: "GROQ_API_KEY not set" };
  const payload = JSON.stringify({
    model: MODEL,
    temperature: 0,
    max_completion_tokens: opts.maxTokens ?? 1500,
    ...(MODEL.startsWith("openai/gpt-oss") ? { reasoning_effort: opts.effort ?? "low" } : {}),
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
      return { ok: true, data: JSON.parse(text) as T, model: body.model ?? MODEL };
    } catch (err) {
      if (err instanceof SyntaxError) return { ok: false, reason: "LLM returned invalid JSON" };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, reason: "LLM rate limited" };
}

// ───────────────────────────── Claude ─────────────────────────────

let _client: Anthropic | null = null;
const client = () => (_client ??= new Anthropic());

async function claude<T>(opts: StructuredOpts): Promise<StructuredResult<T>> {
  try {
    const res = await client().beta.messages.create({
      model: MODEL,
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
