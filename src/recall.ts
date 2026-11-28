// Recall test for training canaries: ask models whether they can complete invented facts
// that only ever existed inside prompts Verity sent. A model that completes one was
// trained on prompts that should not have been kept. Run it on models released after
// the facts were planted; a run on today's models is a baseline that should find nothing.
//
// Usage: node src/recall.ts [--facts 30] [--only id1,id2] [--out results/recall]
// Facts come from the listener's private vault (GitHub OIDC). Results publish only
// commitments and counts, never the facts.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runProbe } from "./client.ts";
import { oidcFetch } from "./chain.ts";
import { recallPrompt, recalled, type VaultRecord } from "./memorize.ts";
import type { Endpoint, Probe } from "./types.ts";

const arg = (n: string, d: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const nFacts = Number(arg("--facts", "30"));
const only = arg("--only", "").split(",").filter(Boolean);
const outDir = arg("--out", "results/recall");

const targets = existsSync("canary-targets.json") ? (JSON.parse(readFileSync("canary-targets.json", "utf8")).endpoints as Endpoint[]) : [];
let models = [...(JSON.parse(readFileSync("endpoints.json", "utf8")) as Endpoint[]), ...targets].filter((e) => process.env[e.keyEnv]);
if (only.length) models = models.filter((e) => only.includes(e.id));

const res = await oidcFetch("/__verity/vault");
if (!res.ok) throw new Error(`vault read failed: HTTP ${res.status}`);
const vault = ((await res.json()) as { records: VaultRecord[] }).records;
// Most recent facts first, so each run also covers the newest seeding.
const facts = vault.sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, nFacts);
console.log(`Vault holds ${vault.length} facts; testing ${facts.length} against ${models.length} models.`);

const results = [];
for (const m of models) {
  let asked = 0, answered = 0;
  const hits: { commitment: string; plantedOn: string; plantedAt: string }[] = [];
  for (const f of facts) {
    const probe: Probe = { id: "recall", kind: "fingerprint", maxTokens: 40, messages: [{ role: "user", content: recallPrompt(f) }] };
    const o = await runProbe(m, probe, process.env[m.keyEnv]!);
    asked++;
    if (!o.ok) continue;
    answered++;
    if (recalled(o.text, f)) hits.push({ commitment: f.commitment, plantedOn: f.endpointId, plantedAt: f.runId });
    await new Promise((r) => setTimeout(r, 800));
  }
  results.push({ endpointId: m.id, host: m.host, model: m.model, asked, answered, recalled: hits.length, hits });
  console.log(`${m.id}: ${hits.length} of ${answered} answered recalled a planted fact`);
}
const day = new Date().toISOString().slice(0, 10);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${day}.json`), JSON.stringify({ day, factsInVault: vault.length, factsTested: facts.length, results }, null, 1));
