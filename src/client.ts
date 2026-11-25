// One OpenAI-compatible chat call, turned into an Observation. Keys come from the
// environment only and are never written to results.
import type { Endpoint, Observation, Probe, ToolCall } from "./types.ts";

export type Fetch = typeof fetch;

export async function runProbe(
  ep: Endpoint, probe: Probe, apiKey: string, fetchImpl: Fetch = fetch, timeoutMs = 90_000,
): Promise<Observation> {
  const body: Record<string, unknown> = {
    model: ep.modelName,
    messages: probe.messages,
    max_tokens: probe.maxTokens,
    temperature: 0,
    seed: 7,
    stream: false,
    ...(probe.tools ? { tools: probe.tools, tool_choice: "auto" } : {}),
    ...(ep.extraBody ?? {}),
  };
  const base: Observation = {
    endpointId: ep.id, probeId: probe.id, ok: false, status: 0, latencyMs: 0, text: "",
    toolCalls: [], finishReason: null, promptTokens: null, completionTokens: null,
    reasoningTokens: null, servedModel: null,
  };
  const started = performance.now();
  try {
    const res = await fetchImpl(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.round(performance.now() - started);
    const raw = await res.text();
    if (!res.ok) {
      return { ...base, status: res.status, latencyMs, error: raw.slice(0, 300) };
    }
    return { ...parseCompletion(raw, base), status: res.status, latencyMs };
  } catch (err) {
    return {
      ...base,
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Parse a chat completion body. A 200 with an unparseable or empty body is recorded, not thrown. */
export function parseCompletion(raw: string, base: Observation): Observation {
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...base, ok: true, error: "200 response with a body that is not JSON" };
  }
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls: ToolCall[] = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((t: any) => ({
        name: String(t?.function?.name ?? ""),
        arguments: typeof t?.function?.arguments === "string"
          ? t.function.arguments
          : JSON.stringify(t?.function?.arguments ?? null),
      }))
    : [];
  const usage = json?.usage ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    ...base,
    ok: true,
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    reasoningTokens: num(usage?.completion_tokens_details?.reasoning_tokens),
    servedModel: typeof json?.model === "string" ? json.model : null,
  };
}
