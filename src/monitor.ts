// Verity Monitor: continuous data-handling checks for your own inference endpoint.
//
// Each run (1) asks the listener whether any bait from earlier runs has come back and
// fails if so, then (2) commits fresh bait hashes to your repository before sending,
// and (3) sends the bait through your endpoint with your key. Tokens never leave this
// process except inside the prompts; only their SHA-256 is written down.
//
// Usage: node src/monitor.ts --base-url https://host/v1 --model NAME [--key-env VERITY_API_KEY]
//          [--count 2] [--dir .verity] [--listener URL] [--no-push]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runProbe } from "./client.ts";
import { TEMPLATE_COUNT, baitPrompt, merkleRoot, newToken, sha256hex } from "./canary.ts";
import type { Endpoint, Probe } from "./types.ts";

export const DEFAULT_LISTENER = "https://teamdocs-portal.vercel.app";

export interface MonitorSeed {
  urlCommitment: string; keyCommitment: string; template: number; committedAt: string;
  sentAt?: string; status?: number; delivered?: boolean;
}
export interface MonitorRun {
  version: 1; runId: string; endpointHost: string; model: string; listener: string;
  root: string; publishedCommit?: string | null;
  timestamp?: { kind: "opentimestamps"; calendar: string; proof: string } | null;
  seeds: MonitorSeed[];
}
export interface FiredBait {
  hash: string; firstAt: string; lastAt: string; count: number;
  via: string[]; countries: string[]; userAgents: string[];
}

/** Every commitment hash in earlier runs, mapped to the run it came from. */
export function priorHashes(runs: MonitorRun[]): Map<string, { runId: string; route: "link" | "key"; sentAt?: string }> {
  const out = new Map<string, { runId: string; route: "link" | "key"; sentAt?: string }>();
  for (const r of runs) for (const s of r.seeds) {
    if (!s.delivered) continue; // bait that never reached the host proves nothing either way
    out.set(s.urlCommitment, { runId: r.runId, route: "link", sentAt: s.sentAt });
    out.set(s.keyCommitment, { runId: r.runId, route: "key", sentAt: s.sentAt });
  }
  return out;
}

export function planRun(baseUrl: string, model: string, listener: string, count: number, now = new Date()) {
  const committedAt = now.toISOString();
  const runId = committedAt.replace(/[:.]/g, "-");
  const tokens: { url: string; key: string }[] = [];
  const seeds: MonitorSeed[] = [];
  for (let i = 0; i < count; i++) {
    const url = newToken(), key = newToken();
    tokens.push({ url, key });
    seeds.push({ urlCommitment: sha256hex(url), keyCommitment: sha256hex(key), template: Math.floor(Math.random() * TEMPLATE_COUNT), committedAt });
  }
  const run: MonitorRun = {
    version: 1, runId, endpointHost: new URL(baseUrl).host, model, listener,
    root: merkleRoot(seeds.flatMap((s) => [s.urlCommitment, s.keyCommitment])), seeds,
  };
  return { run, tokens };
}

export function describeFired(fired: FiredBait[], index: ReturnType<typeof priorHashes>): string[] {
  return fired.map((f) => {
    const src = index.get(f.hash);
    return `Bait from run ${src?.runId ?? "?"} (${src?.route ?? "?"}, sent ${src?.sentAt ?? "?"}) came back ${f.count} time(s), first at ${f.firstAt}` +
      ` via ${f.via.join("/")} from ${f.countries.join(", ") || "unknown country"}; user agents: ${f.userAgents.join(" | ") || "none"}`;
  });
}

async function main() {
  const arg = (n: string, d?: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
  const baseUrl = arg("--base-url"), model = arg("--model");
  const keyEnv = arg("--key-env", "VERITY_API_KEY")!;
  const count = Math.max(1, Math.min(20, Number(arg("--count", "2"))));
  const dir = arg("--dir", ".verity")!;
  const listener = (arg("--listener", DEFAULT_LISTENER) || DEFAULT_LISTENER).replace(/\/$/, "");
  const push = !process.argv.includes("--no-push");
  if (!baseUrl || !model) throw new Error("--base-url and --model are required");
  const apiKey = process.env[keyEnv];
  if (!apiKey) throw new Error(`no API key in ${keyEnv}`);
  const summary = (line: string) => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n"); };

  // 1. Has anything from earlier runs come back?
  const seedDir = join(dir, "seeds");
  const runs: MonitorRun[] = existsSync(seedDir)
    ? readdirSync(seedDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(seedDir, f), "utf8")))
    : [];
  const index = priorHashes(runs);
  let fired: FiredBait[] = [];
  if (index.size > 0) {
    const r = await fetch(`${listener}/check`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hashes: [...index.keys()] }), signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`listener check failed: HTTP ${r.status}`);
    fired = ((await r.json()) as { fired: FiredBait[] }).fired;
  }
  summary(`## Verity Monitor: ${new URL(baseUrl).host} (${model})`);
  summary(`Checked ${index.size / 2} earlier bait prompts: ${fired.length === 0 ? "none have come back." : `**${fired.length} came back.**`}`);
  for (const line of describeFired(fired, index)) summary(`- ${line}`);

  // 2. Commit new bait before sending it.
  const { run, tokens } = planRun(baseUrl, model, listener, count);
  const file = join(seedDir, `${run.runId}.json`);
  const save = () => { mkdirSync(seedDir, { recursive: true }); writeFileSync(file, JSON.stringify(run, null, 1) + "\n"); };
  try {
    const cal = "https://a.pool.opentimestamps.org";
    const r = await fetch(`${cal}/digest`, { method: "POST", body: Buffer.from(run.root, "hex"), signal: AbortSignal.timeout(20_000) });
    if (r.ok) run.timestamp = { kind: "opentimestamps", calendar: cal, proof: Buffer.from(await r.arrayBuffer()).toString("base64") };
  } catch { /* best effort */ }
  save();
  const git = (c: string) => execSync(c, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
  const commit = (msg: string) => {
    git(`git add ${JSON.stringify(dir)}`);
    git(`git -c user.name=verity-monitor -c user.email=41898282+github-actions[bot]@users.noreply.github.com commit -q -m ${JSON.stringify(msg)}`);
    git("git pull -q --rebase && git push -q");
    return git("git rev-parse HEAD");
  };
  if (push) {
    run.publishedCommit = commit(`Verity bait commitments ${run.runId} (before sending)`);
    save();
  }

  // 3. Send the bait through the endpoint.
  const ep: Endpoint = { id: "monitored", host: new URL(baseUrl).host, via: "direct", baseUrl, keyEnv, model, modelName: model };
  for (let i = 0; i < run.seeds.length; i++) {
    const s = run.seeds[i];
    const probe: Probe = { id: "bait", kind: "fingerprint", maxTokens: 200,
      messages: [{ role: "user", content: baitPrompt(s.template, listener, tokens[i].url, tokens[i].key) }] };
    const o = await runProbe(ep, probe, apiKey);
    Object.assign(s, { sentAt: new Date().toISOString(), status: o.status, delivered: o.ok });
  }
  save();
  if (push) commit(`Verity bait sent ${run.runId}`);
  const delivered = run.seeds.filter((s) => s.delivered).length;
  summary(`Sent ${delivered} of ${run.seeds.length} new bait prompts${delivered < run.seeds.length ? " (some requests failed; they are not counted)" : ""}.`);
  if (fired.length > 0) process.exitCode = 1;
  if (delivered === 0) { summary("No bait reached the endpoint in this run."); process.exitCode = 1; }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
