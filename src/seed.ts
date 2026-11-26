// One seeding run: make bait for every keyed endpoint, publish only the hashes, anchor
// their Merkle root on Solana, and only then send the prompts. Tokens exist in memory
// only and are never written or printed.
//
// Usage: node src/seed.ts [--per-endpoint 3] [--out results/canary] [--selftest] [--no-anchor]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runProbe } from "./client.ts";
import { anchorMemo, type MemoReceipt } from "./chain.ts";
import { TEMPLATE_COUNT, baitPrompt, merkleRoot, newToken, sha256hex, type Seed } from "./canary.ts";
import type { Endpoint, Probe } from "./types.ts";

const arg = (n: string, d: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const perEndpoint = Number(arg("--per-endpoint", "3"));
const outDir = arg("--out", "results/canary");
const selftest = process.argv.includes("--selftest");
const noAnchor = process.argv.includes("--no-anchor");
const listener = (JSON.parse(readFileSync("canary.json", "utf8")).listener as string) || process.env.VERITY_LISTENER || "";
if (!listener) { console.error("Set the listener URL in canary.json first."); process.exit(1); }
process.env.VERITY_LISTENER = listener;

const endpoints = (JSON.parse(readFileSync("endpoints.json", "utf8")) as Endpoint[]).filter((e) => process.env[e.keyEnv]);
const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, "-");

interface Planned { seed: Seed; ep?: Endpoint; urlToken: string; keyToken: string }
const planned: Planned[] = [];
for (const ep of endpoints) {
  for (let i = 0; i < perEndpoint; i++) {
    const urlToken = newToken(), keyToken = newToken();
    planned.push({
      ep, urlToken, keyToken,
      seed: {
        urlCommitment: sha256hex(urlToken), keyCommitment: sha256hex(keyToken),
        endpointId: ep.id, host: ep.host, via: ep.via, model: ep.model,
        template: (i + planned.length) % TEMPLATE_COUNT, committedAt: startedAt,
      },
    });
  }
}
if (selftest) {
  const urlToken = newToken(), keyToken = newToken();
  planned.push({
    urlToken, keyToken,
    seed: { urlCommitment: sha256hex(urlToken), keyCommitment: sha256hex(keyToken), endpointId: "verity-selftest", host: "Verity self-test", via: "direct", model: "none", template: 0, committedAt: startedAt },
  });
}
if (planned.length === 0) { console.log("No endpoint has a key; nothing to seed."); process.exit(0); }

const root = merkleRoot(planned.flatMap((p) => [p.seed.urlCommitment, p.seed.keyCommitment]));
const memo = `verity canary v1 ${runId} root=${root} n=${planned.length}`;
let anchor: MemoReceipt | null = null;
if (!noAnchor) {
  anchor = await anchorMemo(memo); // throws before anything is sent if anchoring fails
  console.log(`Committed ${planned.length} seeds on ${anchor.cluster}: ${anchor.explorer}`);
}

const file = join(outDir, "seeds", `${runId}.json`);
const save = () => {
  mkdirSync(join(outDir, "seeds"), { recursive: true });
  writeFileSync(file, JSON.stringify({ runId, startedAt, listener, root, memo, anchor, seeds: planned.map((p) => p.seed) }, null, 1));
  const indexPath = join(outDir, "index.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { runs: [] };
  if (!index.runs.includes(runId)) index.runs.push(runId);
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
};
save(); // hashes are public before the first prompt goes out

await Promise.all(endpoints.map(async (ep) => {
  for (const p of planned.filter((x) => x.ep?.id === ep.id)) {
    const probe: Probe = {
      id: "bait", kind: "fingerprint", maxTokens: 200,
      messages: [{ role: "user", content: baitPrompt(p.seed.template, listener, p.urlToken, p.keyToken) }],
    };
    const o = await runProbe(ep, probe, process.env[ep.keyEnv]!);
    p.seed.sentAt = new Date().toISOString();
    p.seed.status = o.status;
    p.seed.delivered = o.ok;
    await new Promise((r) => setTimeout(r, 1500));
  }
}));

const self = planned.find((p) => p.seed.endpointId === "verity-selftest");
if (self) {
  // Touch our own bait once, so the pipeline is proven end to end.
  const r = await fetch(`${listener.replace(/\/$/, "")}/d/${self.urlToken}`).catch(() => null);
  self.seed.sentAt = new Date().toISOString();
  self.seed.status = r?.status ?? 0;
  self.seed.delivered = !!r?.ok;
}
save();
const delivered = planned.filter((p) => p.seed.delivered).length;
console.log(`Seeded ${planned.length} prompts, ${delivered} delivered. File: ${file}`);
