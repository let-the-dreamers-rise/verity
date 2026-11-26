// Re-score a day's stored raw evidence with the current scoring rules. Sends nothing.
// Usage: node src/rescore.ts YYYY-MM-DD [--endpoints path] [--out dir]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport, sha256 } from "./audit.ts";
import { loadProbes } from "./probes.ts";
import type { Endpoint, Observation } from "./types.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const day = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
  console.error("Usage: node src/rescore.ts YYYY-MM-DD");
  process.exit(1);
}
const outDir = arg("--out", "results");
const rawText = readFileSync(join(outDir, "raw", `${day}.json`), "utf8");
const observations = JSON.parse(rawText) as Observation[];
const old = JSON.parse(readFileSync(join(outDir, `${day}.json`), "utf8"));
const seen = new Set(observations.map((o) => o.endpointId));
const endpoints = (JSON.parse(readFileSync(arg("--endpoints", "endpoints.json"), "utf8")) as Endpoint[])
  .filter((e) => seen.has(e.id));
const report = buildReport(endpoints, loadProbes(), observations, old.startedAt, old.finishedAt);
const text = JSON.stringify({ ...report, evidence: { file: `raw/${day}.json`, sha256: sha256(rawText) } }, null, 2);
writeFileSync(join(outDir, `${day}.json`), text);
if (JSON.parse(readFileSync(join(outDir, "latest.json"), "utf8")).startedAt === old.startedAt) {
  writeFileSync(join(outDir, "latest.json"), text);
}
for (const s of report.endpoints) console.log(`${s.endpointId}: ${s.flags.length ? s.flags.join(", ") : "no flags"}`);
