import assert from "node:assert/strict";
import { test } from "node:test";
import { verify } from "node:crypto";
import { b58decode, b58encode, compactU16, MEMO_PROGRAM, memoTransaction, publicKeyObject, signerFrom } from "../src/solana.ts";

test("base58 matches known Solana ids", () => {
  assert.equal(b58encode(new Uint8Array(32)), "11111111111111111111111111111111");
  assert.equal(b58decode(MEMO_PROGRAM).length, 32);
  assert.equal(b58encode(b58decode(MEMO_PROGRAM)), MEMO_PROGRAM);
});

test("compact-u16 encodes like Solana's short vec", () => {
  assert.deepEqual(compactU16(0), [0]);
  assert.deepEqual(compactU16(127), [0x7f]);
  assert.deepEqual(compactU16(128), [0x80, 0x01]);
  assert.deepEqual(compactU16(16384), [0x80, 0x80, 0x01]);
});

test("a memo transaction is signed by its payer and carries the memo", () => {
  const s = signerFrom();
  const memo = "verity v1 2026-11-26 raw=abc report=def";
  const { tx, message } = memoTransaction(s, b58encode(new Uint8Array(32).fill(7)), memo);
  assert.equal(tx[0], 1);
  const sig = tx.slice(1, 65);
  assert.ok(verify(null, message, publicKeyObject(s.publicKey), sig));
  assert.ok(Buffer.from(message).includes(Buffer.from(memo)));
  assert.deepEqual(Array.from(message.slice(4, 36)), Array.from(s.publicKey));
});

test("a solana-keygen secret round-trips to the same public key", () => {
  const fresh = signerFrom();
  const seed = fresh.key.export({ format: "jwk" }).d!;
  const secret = [...Buffer.from(seed, "base64url"), ...fresh.publicKey];
  const again = signerFrom(secret);
  assert.deepEqual(Array.from(again.publicKey), Array.from(fresh.publicKey));
  const { tx, message } = memoTransaction(again, b58encode(new Uint8Array(32).fill(1)), "x");
  assert.ok(verify(null, message, publicKeyObject(fresh.publicKey), tx.slice(1, 65)));
});
