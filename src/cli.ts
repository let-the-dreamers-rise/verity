// Usage: node src/cli.ts [--dry-run] [--skip-if-no-keys] [--endpoints path] [--out dir] [--delay ms]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit, sha256 } from "./audit.ts";
import { loadProbes } from "./probes.ts";
import type { Endpoint } from "./types.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const endpointsPath = arg("--endpoints", "endpoints.json")!;
const outDir = arg("--out", "results")!;
const delayMs = Number(arg("--delay", "1500"));
const dryRun = process.argv.includes("--dry-run");

const endpoints = JSON.parse(readFileSync(endpointsPath, "utf8")) as Endpoint[];
const probes = loadProbes();
const ready = endpoints.filter((e) => process.env[e.keyEnv]);
const missing = [...new Set(endpoints.filter((e) => !process.env[e.keyEnv]).map((e) => e.keyEnv))];

console.log(`Probes: ${probes.length}. Endpoints with a key: ${ready.length} of ${endpoints.length}.`);
if (missing.length) console.log(`No key set for: ${missing.join(", ")}`);
for (const e of ready) console.log(`  ${e.id}  (${e.model} on ${e.host} via ${e.via})`);

if (dryRun) {
  console.log(`Dry run: would make ${ready.length * probes.length} calls. Nothing sent.`);
  process.exit(0);
}
if (ready.length === 0) {
  console.error("No endpoint has an API key in the environment. Nothing to audit.");
  process.exit(process.argv.includes("--skip-if-no-keys") ? 0 : 1);
}

const { report, observations } = await runAudit(endpoints, probes, {
  delayMs,
  onProgress: (done, total) => {
    if (done % 10 === 0 || done === total) console.log(`  ${done}/${total} calls`);
  },
});

if (report.endpoints.every((s) => s.probes === 0)) {
  console.error("No host was measured, so nothing is published:");
  for (const c of report.caveats) console.error(`  ${c}`);
  process.exit(1);
}

const day = report.startedAt.slice(0, 10);
mkdirSync(join(outDir, "raw"), { recursive: true });
const rawText = JSON.stringify(observations, null, 1);
const rawHash = sha256(rawText);
const full = { ...report, evidence: { file: `raw/${day}.json`, sha256: rawHash } };
const reportText = JSON.stringify(full, null, 2);
writeFileSync(join(outDir, "raw", `${day}.json`), rawText);
writeFileSync(join(outDir, `${day}.json`), reportText);
writeFileSync(join(outDir, "latest.json"), reportText);
const days = readdirSync(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
writeFileSync(join(outDir, "index.json"), JSON.stringify({ days }, null, 2));

console.log(`\nWrote ${outDir}/${day}.json. Evidence sha256: ${rawHash}`);
for (const s of report.endpoints) {
  console.log(`  ${s.endpointId}: ${s.flags.length ? s.flags.join(", ") : "no flags"}`);
}
