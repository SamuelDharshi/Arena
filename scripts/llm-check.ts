import Anthropic from "@anthropic-ai/sdk";

/** Validates the configured LLM provider's credentials (Groq when GROQ_API_KEY is set, else Claude). */
export async function checkLlm(): Promise<{ provider: string; ok: boolean; detail: string }> {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${groqKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
      if (res.ok && body.data?.some((m) => m.id === model)) return { provider: "groq", ok: true, detail: `Groq key valid (${model})` };
      if (res.ok) return { provider: "groq", ok: false, detail: `Groq key valid but model ${model} is not available — set GROQ_MODEL` };
      return { provider: "groq", ok: false, detail: `Groq ${res.status === 401 ? "key invalid (401)" : `check failed (${res.status})`} — fix GROQ_API_KEY in .env` };
    } catch (err) {
      return { provider: "groq", ok: false, detail: `Groq check failed: ${(err as Error).message}` };
    }
  }
  const model = process.env.AGENT_MODEL || "claude-opus-5-5";
  try {
    await new Anthropic().models.retrieve(model);
    return { provider: "anthropic", ok: true, detail: `Anthropic key valid (${model})` };
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? err.status : undefined;
    return { provider: "anthropic", ok: false, detail: `No working LLM key (Anthropic ${status === 401 ? "401" : "check failed"}) — set GROQ_API_KEY or ANTHROPIC_API_KEY in .env` };
  }
}
