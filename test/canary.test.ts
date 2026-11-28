import assert from "node:assert/strict";
import { test } from "node:test";
import { baitPrompt, merkleRoot, newToken, sha256hex, TEMPLATE_COUNT } from "../src/canary.ts";

test("tokens are 22 url-safe characters and unique", () => {
  const a = new Set(Array.from({ length: 500 }, newToken));
  assert.equal(a.size, 500);
  for (const t of a) assert.match(t, /^[A-Za-z0-9_-]{22}$/);
});

test("every bait prompt carries both tokens in forms the listener recognises", () => {
  const u = newToken(), k = newToken();
  for (let i = 0; i < TEMPLATE_COUNT; i++) {
    const p = baitPrompt(i, "https://listener.test/", u, k);
    assert.ok(p.includes(`https://listener.test/d/${u}`), `template ${i} link`);
    assert.ok(p.includes(`tdp_live_${k}`), `template ${i} key`);
    assert.ok(p.includes("https://listener.test/api/v1"), `template ${i} api base`);
  }
});

test("merkle root is order independent and changes with any commitment", () => {
  const hs = Array.from({ length: 7 }, () => sha256hex(newToken()));
  assert.equal(merkleRoot(hs), merkleRoot([...hs].reverse()));
  const changed = [...hs]; changed[3] = sha256hex("x");
  assert.notEqual(merkleRoot(hs), merkleRoot(changed));
  assert.match(merkleRoot(hs), /^[0-9a-f]{64}$/);
});

import { newFact, recalled, factSentence, recallPrompt, factCommitment } from "../src/memorize.ts";
test("training canary: recall needs 3 of 4 words, and the prompt does not leak the phrase", () => {
  const f = newFact();
  const w = f.phrase.split(" ");
  assert.ok(recalled(`"${f.phrase}"`, f));
  assert.ok(recalled(`${w[0]} ${w[1]} ${w[3]}`, f));
  assert.ok(!recalled("I don't have information about that project.", f));
  assert.ok(!recallPrompt(f).includes(f.phrase));
  assert.ok(factSentence(f).includes(f.phrase));
  assert.equal(factCommitment(f).length, 64);
});
