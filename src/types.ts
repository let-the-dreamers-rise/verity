// Shared types. Kept dependency-free so the whole project runs on plain Node.

export interface Endpoint {
  /** Stable id used in results, e.g. "openrouter/deepinfra". */
  id: string;
  /** Human name of the company that actually runs the GPUs. */
  host: string;
  /** How we reach it, e.g. "openrouter", "groq", "hf-router", "direct". */
  via: string;
  baseUrl: string;
  /** Name of the environment variable holding the API key. Never the key itself. */
  keyEnv: string;
  /** Model family id shared across hosts, e.g. "llama-3.3-70b". */
  model: string;
  /** The model string this endpoint expects. */
  modelName: string;
  /** Extra JSON merged into the request body (e.g. OpenRouter provider pinning). */
  extraBody?: Record<string, unknown>;
  /** True for the endpoint we treat as the reference for this model. */
  reference?: boolean;
}

export type ProbeKind = "echo" | "tool" | "long" | "fingerprint";

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  additionalProperties?: boolean;
}

export interface Probe {
  id: string;
  kind: ProbeKind;
  messages: { role: "system" | "user"; content: string }[];
  maxTokens: number;
  tools?: ToolDef[];
  /** For echo probes: the exact text the model was asked to return. */
  expectText?: string;
  /** For tool probes: the tool that must be called. */
  expectTool?: string;
  /** For long probes: a marker the answer must end with if it was not cut off. */
  endMarker?: string;
}

export interface ToolCall {
  name: string;
  arguments: string;
}

export interface Observation {
  endpointId: string;
  probeId: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  /** Model name the host says it served, if it says. */
  servedModel: string | null;
  error?: string;
}

export interface CheckResult {
  check: string;
  pass: boolean;
  detail: string;
}

export interface EndpointScore {
  endpointId: string;
  host: string;
  via: string;
  model: string;
  reference: boolean;
  probes: number;
  /** Calls answered with HTTP 429; these are excluded from every rate. */
  rateLimited: number;
  /** Set when every call was refused with a 4xx: our setup is wrong, the host was not measured. */
  setupError: string | null;
  /** Share of probes that returned a usable response at all. */
  availability: number;
  /** Share of tool probes with a valid, schema-correct call to the right tool. */
  toolCallAccuracy: number | null;
  /** Share of long probes that were cut off or came back empty. */
  truncationRate: number | null;
  /** Billed completion tokens divided by the cross-host median, on identical outputs. 1.0 = in line. */
  tokenRatio: number | null;
  /** Mean text similarity to the reference host at temperature 0, 0..1. */
  similarity: number | null;
  medianLatencyMs: number | null;
  flags: string[];
}

export interface AuditReport {
  schema: 1;
  startedAt: string;
  finishedAt: string;
  probeCount: number;
  endpoints: EndpointScore[];
  /** Short honest notes about what this run can and cannot show. */
  caveats: string[];
}
