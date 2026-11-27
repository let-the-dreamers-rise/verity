import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFired, planRun, priorHashes } from "../src/monitor.ts";
import { merkleRoot, sha256hex } from "../src/canary.ts";

test("planRun commits only hashes and a matching root", () => {
  const { run, tokens } = planRun("https://api.example.com/v1", "m", "https://l.example", 3, new Date("2026-11-27T00:00:00Z"));
  assert.equal(run.seeds.length, 3);
  assert.equal(run.endpointHost, "api.example.com");
  const text = JSON.stringify(run);
  for (const t of tokens) { assert.ok(!text.includes(t.url)); assert.ok(!text.includes(t.key)); }
  assert.equal(run.seeds[0].urlCommitment, sha256hex(tokens[0].url));
  assert.equal(run.root, merkleRoot(run.seeds.flatMap((s) => [s.urlCommitment, s.keyCommitment])));
});

test("priorHashes skips bait that was never delivered", () => {
  const { run } = planRun("https://a.example/v1", "m", "https://l", 2);
  run.seeds[0].delivered = true; run.seeds[1].delivered = false;
  const idx = priorHashes([run]);
  assert.equal(idx.size, 2);
  assert.equal(idx.get(run.seeds[0].keyCommitment)?.route, "key");
  assert.ok(!idx.has(run.seeds[1].urlCommitment));
});

test("describeFired names the run and route", () => {
  const { run } = planRun("https://a.example/v1", "m", "https://l", 1);
  run.seeds[0].delivered = true;
  const idx = priorHashes([run]);
  const [line] = describeFired([{ hash: run.seeds[0].urlCommitment, firstAt: "t1", lastAt: "t1", count: 1, via: ["path"], countries: ["US"], userAgents: ["bot"] }], idx);
  assert.match(line, new RegExp(run.runId));
  assert.match(line, /link/);
});
