// Check one OpenAI-compatible endpoint the way the audit checks hosts: tool calls
// that must fit their schema, and long answers that must finish. Exits non-zero
// below the threshold, so it can gate a deploy in CI.
//
// Usage:
//   node src/check.ts --base-url https://api.example.com/v1 --model my-model [--key-env MY_KEY]
//                     [--min-tool-accuracy 0.9] [--delay 500] [--json] [--only tool|long]
import { runProbe } from "./client.ts";
import { checkToolCall, checkTruncation } from "./scorers.ts";
import { loadProbes } from "./probes.ts";
import type { Endpoint, Probe } from "./types.ts";

export interface CheckLine { probeId: string; kind: string; pass: boolean; detail: string; asked: string; got: string }
export interface CheckSummary {
  endpoint: string;
  model: string;
  toolCallsPassed: number;
  toolCallsScored: number;
  longPassed: number;
  longScored: number;
  skipped: number;
  lines: CheckLine[];
  pass: boolean;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function runCheck(
  ep: Endpoint, probes: Probe[], apiKey: string,
  opts: { minToolAccuracy?: number; delayMs?: number; fetchImpl?: typeof fetch; onLine?: (l: CheckLine) => void } = {},
): Promise<CheckSummary> {
  const lines: CheckLine[] = [];
  let skipped = 0;
  for (const probe of probes) {
    const o = await runProbe(ep, probe, apiKey, opts.fetchImpl);
    if (o.status === 429 || o.status === 402) {
      skipped++;
    } else {
      const res = probe.kind === "tool" ? checkToolCall(o, probe) : checkTruncation(o, probe);
      const got = o.toolCalls.length
        ? `${o.toolCalls[0].name}(${o.toolCalls[0].arguments})`
        : (o.text.trim() || o.error || `HTTP ${o.status}`).replace(/\s+/g, " ");
      const line = {
        probeId: probe.id, kind: probe.kind, pass: res.pass, detail: res.detail,
        asked: String(probe.messages.at(-1)?.content ?? ""), got: got.slice(0, 240),
      };
      lines.push(line);
      opts.onLine?.(line);
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  const tool = lines.filter((l) => l.kind === "tool");
  const long = lines.filter((l) => l.kind === "long");
  const toolPassed = tool.filter((l) => l.pass).length;
  const min = opts.minToolAccuracy ?? 0.9;
  return {
    endpoint: ep.baseUrl,
    model: ep.modelName,
    toolCallsPassed: toolPassed,
    toolCallsScored: tool.length,
    longPassed: long.filter((l) => l.pass).length,
    longScored: long.length,
    skipped,
    lines,
    pass: lines.length > 0 && (tool.length === 0 || toolPassed / tool.length >= min) && long.every((l) => l.pass),
  };
}

if (import.meta.main) {
  const baseUrl = arg("--base-url");
  const model = arg("--model");
  const keyEnv = arg("--key-env") ?? "VERITY_API_KEY";
  const only = arg("--only");
  const json = process.argv.includes("--json");
  if (!baseUrl || !model) {
    console.error("Usage: node src/check.ts --base-url <url ending in /v1> --model <model> [--key-env ENV_NAME]");
    process.exit(2);
  }
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    console.error(`Put the API key in the ${keyEnv} environment variable. It is read from there only and never printed.`);
    process.exit(2);
  }
  const probes = loadProbes().filter((p) => (only ? p.kind === only : p.kind === "tool" || p.kind === "long"));
  const ep: Endpoint = { id: "check", host: "check", via: "direct", baseUrl, keyEnv, model, modelName: model };
  if (!json) console.log(`Checking ${model} at ${baseUrl} with ${probes.length} probes.\n`);
  const summary = await runCheck(ep, probes, apiKey, {
    minToolAccuracy: Number(arg("--min-tool-accuracy") ?? 0.9),
    delayMs: Number(arg("--delay") ?? 500),
    onLine: json ? undefined : (l) => {
      console.log(`${l.pass ? "PASS" : "FAIL"}  ${l.probeId.padEnd(8)} ${l.pass ? "" : l.detail}`);
      if (!l.pass) console.log(`        asked: ${l.asked.slice(0, 120)}\n        got:   ${l.got.slice(0, 160)}`);
    },
  });
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\nTool calls: ${summary.toolCallsPassed} of ${summary.toolCallsScored} valid.`);
    if (summary.longScored) console.log(`Long answers: ${summary.longPassed} of ${summary.longScored} complete.`);
    if (summary.skipped) console.log(`Skipped: ${summary.skipped} (rate or credit limit).`);
    console.log(summary.pass ? "\nResult: PASS" : "\nResult: FAIL");
  }
  process.exit(summary.pass ? 0 : 1);
}
