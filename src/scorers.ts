// Pure scoring functions. No network, no clock: everything here is unit-tested.
import type {
  CheckResult, Endpoint, EndpointScore, JsonSchema, Observation, Probe,
} from "./types.ts";

/** Thresholds are first guesses. They must be re-set from a measured noise band
 *  (same host, same probe, repeated) before any host is named publicly. */
export const THRESHOLDS = {
  availability: 0.95,
  toolCallAccuracy: 0.9,
  truncationRate: 0.05,
  tokenRatio: 1.15,
  similarity: 0.6,
};

/** Minimal JSON Schema check: type, properties, required, enum, items, additionalProperties:false. */
export function validateSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  }
  const t = schema.type;
  if (t) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const okType =
      t === actual ||
      (t === "integer" && actual === "number" && Number.isInteger(value)) ||
      (t === "number" && actual === "number");
    if (!okType) {
      errors.push(`${path}: expected ${t}, got ${actual}`);
      return errors;
    }
  }
  if (schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj) errors.push(...validateSchema(obj[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) errors.push(`${path}.${key}: not allowed`);
      }
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((v, i) => errors.push(...validateSchema(v, schema.items!, `${path}[${i}]`)));
  }
  return errors;
}

/** A tool probe passes only if the right tool is called with arguments that parse and fit the schema. */
export function checkToolCall(obs: Observation, probe: Probe): CheckResult {
  const check = "tool-call";
  if (!obs.ok) return { check, pass: false, detail: `request failed (${obs.status})` };
  if (obs.toolCalls.length === 0) return { check, pass: false, detail: "no tool call returned" };
  const call = obs.toolCalls[0];
  if (call.name !== probe.expectTool) {
    return { check, pass: false, detail: `called "${call.name}", expected "${probe.expectTool}"` };
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return { check, pass: false, detail: "arguments are not valid JSON" };
  }
  const tool = probe.tools?.find((t) => t.function.name === probe.expectTool);
  if (!tool) return { check, pass: false, detail: "probe has no schema for the expected tool" };
  const errors = validateSchema(args, tool.function.parameters);
  return errors.length
    ? { check, pass: false, detail: `schema errors: ${errors.join("; ")}` }
    : { check, pass: true, detail: "valid call" };
}

/** A long probe fails if the answer is empty, was cut by the token limit, or lacks its end marker. */
export function checkTruncation(obs: Observation, probe: Probe): CheckResult {
  const check = "truncation";
  if (!obs.ok) return { check, pass: false, detail: `request failed (${obs.status})` };
  if (obs.text.trim() === "") return { check, pass: false, detail: "empty body on a successful response" };
  if (obs.finishReason === "length") return { check, pass: false, detail: "stopped by token limit" };
  if (probe.endMarker && !obs.text.trimEnd().endsWith(probe.endMarker)) {
    return { check, pass: false, detail: `missing end marker "${probe.endMarker}"` };
  }
  return { check, pass: true, detail: "complete" };
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Word-bigram Dice similarity, 0..1. Short texts fall back to exact match after normalizing. */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const wa = na.split(" ").filter(Boolean);
  const wb = nb.split(" ").filter(Boolean);
  if (wa.length < 2 || wb.length < 2) return 0;
  const grams = (w: string[]) => {
    const m = new Map<string, number>();
    for (let i = 0; i < w.length - 1; i++) {
      const g = `${w[i]} ${w[i + 1]}`;
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(wa);
  const gb = grams(wb);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / (wa.length - 1 + (wb.length - 1));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((x, y) => x + y, 0) / values.length : null;
}

function round(n: number | null, places = 3): number | null {
  if (n === null) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Token ratio. On an echo probe every honest host of the same model returns the same
 * text, and the same tokenizer must count it the same. So we compare each host's billed
 * completion tokens with the median of its peers on byte-identical outputs. We need no
 * tokenizer of our own and do not trust any single host's count.
 * Needs at least 3 hosts with identical output; otherwise the probe is skipped.
 */
export function tokenRatios(
  endpoints: Endpoint[], probes: Probe[], observations: Observation[],
): Map<string, number> {
  const perEndpoint = new Map<string, number[]>();
  const models = new Set(endpoints.map((e) => e.model));
  for (const model of models) {
    const ids = new Set(endpoints.filter((e) => e.model === model).map((e) => e.id));
    for (const probe of probes.filter((p) => p.kind === "echo" && p.expectText)) {
      const exact = observations.filter(
        (o) =>
          ids.has(o.endpointId) && o.probeId === probe.id && o.ok &&
          o.completionTokens !== null && o.completionTokens > 0 &&
          o.text.trim() === probe.expectText!.trim(),
      );
      if (exact.length < 3) continue;
      // Hidden reasoning legitimately varies in length, so reported reasoning tokens are taken out.
      const answer = (o: Observation) => Math.max(1, o.completionTokens! - (o.reasoningTokens ?? 0));
      const med = median(exact.map(answer))!;
      for (const o of exact) {
        const list = perEndpoint.get(o.endpointId) ?? [];
        list.push(answer(o) / med);
        perEndpoint.set(o.endpointId, list);
      }
    }
  }
  const out = new Map<string, number>();
  for (const [id, ratios] of perEndpoint) out.set(id, mean(ratios)!);
  return out;
}

/**
 * Similarity per endpoint on fingerprint probes. If the model has a reference endpoint
 * that answered, compare with it. Otherwise compare with the peers (mean pairwise),
 * which finds the odd one out without trusting any single host.
 */
export function similarities(
  endpoints: Endpoint[], probes: Probe[], observations: Observation[],
): Map<string, number> {
  const out = new Map<string, number>();
  const fp = probes.filter((p) => p.kind === "fingerprint");
  const byKey = new Map<string, Observation>();
  for (const o of observations) byKey.set(`${o.endpointId}|${o.probeId}`, o);
  for (const ep of endpoints) {
    const peers = endpoints.filter((e) => e.model === ep.model && e.id !== ep.id);
    const ref = peers.find((e) => e.reference);
    const scores: number[] = [];
    for (const probe of fp) {
      const mine = byKey.get(`${ep.id}|${probe.id}`);
      if (!mine?.ok || mine.text.trim() === "") continue;
      const against = (ref ? [ref] : peers)
        .map((e) => byKey.get(`${e.id}|${probe.id}`))
        .filter((o): o is Observation => !!o && o.ok && o.text.trim() !== "");
      // Without a reference, two hosts cannot tell us which one diverged, so we need 2+ peers.
      if (against.length === 0 || (!ref && against.length < 2)) continue;
      const sims = against.map((o) => similarity(mine.text, o.text)).sort((a, b) => b - a);
      // Agreement with the closest half of peers: one odd host cannot drag an honest one down.
      scores.push(ref ? sims[0] : median(sims.slice(0, Math.ceil(sims.length / 2)))!);
    }
    const m = mean(scores);
    if (m !== null && !ep.reference) out.set(ep.id, m);
  }
  return out;
}

export function scoreEndpoints(
  endpoints: Endpoint[], probes: Probe[], observations: Observation[],
): EndpointScore[] {
  const probeById = new Map(probes.map((p) => [p.id, p]));
  const ratios = tokenRatios(endpoints, probes, observations);
  const sims = similarities(endpoints, probes, observations);
  return endpoints.map((ep) => {
    const all = observations.filter((o) => o.endpointId === ep.id);
    // If every call was refused with a 4xx, the endpoint is set up wrong on our side
    // (bad model id, key without access). That is not a measurement of the host.
    const refused = all.length > 0 && all.every((o) => o.status >= 400 && o.status < 500);
    const setupError = refused ? (all[0].error ?? `HTTP ${all[0].status}`) : null;
    // 429 and 402 say our key ran out of quota or credit, not that the host failed: left unscored.
    const obs = refused ? [] : all.filter((o) => o.status !== 429 && o.status !== 402);
    const usable = obs.filter((o) => o.ok && (o.text.trim() !== "" || o.toolCalls.length > 0));
    const toolObs = obs.filter((o) => probeById.get(o.probeId)?.kind === "tool");
    const longObs = obs.filter((o) => probeById.get(o.probeId)?.kind === "long");
    const toolPass = toolObs.filter((o) => checkToolCall(o, probeById.get(o.probeId)!).pass).length;
    const longFail = longObs.filter((o) => !checkTruncation(o, probeById.get(o.probeId)!).pass).length;

    const score: EndpointScore = {
      endpointId: ep.id,
      host: ep.host,
      via: ep.via,
      model: ep.model,
      reference: !!ep.reference,
      probes: obs.length,
      rateLimited: all.filter((o) => o.status === 429 || o.status === 402).length,
      setupError,
      availability: round(obs.length ? usable.length / obs.length : 0)!,
      toolCallAccuracy: round(toolObs.length ? toolPass / toolObs.length : null),
      truncationRate: round(longObs.length ? longFail / longObs.length : null),
      tokenRatio: round(ratios.get(ep.id) ?? null),
      similarity: round(sims.get(ep.id) ?? null),
      medianLatencyMs: round(median(usable.map((o) => o.latencyMs)), 0),
      flags: [],
    };
    const T = THRESHOLDS;
    if (score.probes > 0 && score.availability < T.availability) score.flags.push("low availability");
    if (score.toolCallAccuracy !== null && score.toolCallAccuracy < T.toolCallAccuracy) score.flags.push("tool calls failing");
    if (score.truncationRate !== null && score.truncationRate > T.truncationRate) score.flags.push("answers cut off or empty");
    if (score.tokenRatio !== null && score.tokenRatio > T.tokenRatio) score.flags.push("bills more tokens than peers");
    if (score.similarity !== null && score.similarity < T.similarity) score.flags.push("outputs diverge from peers");
    return score;
  });
}
