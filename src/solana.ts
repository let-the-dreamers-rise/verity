// The few pieces of Solana needed to post a memo, written out so the project keeps
// zero dependencies: base58, compact-u16, a legacy transaction, and ed25519 signing.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

export function b58decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

export function compactU16(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n === 0) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

export interface Signer { publicKey: Uint8Array; key: KeyObject }

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A signer from a solana-keygen 64-byte secret (seed then public key), or a fresh one. */
export function signerFrom(secret?: number[]): Signer {
  if (secret) {
    if (secret.length !== 64) throw new Error("expected a 64-byte solana-keygen secret");
    const seed = Uint8Array.from(secret.slice(0, 32));
    const pub = Uint8Array.from(secret.slice(32));
    const key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64url(seed), x: b64url(pub) }, format: "jwk" });
    return { publicKey: pub, key };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  return { publicKey: Uint8Array.from(Buffer.from(x, "base64url")), key: privateKey };
}

/** A legacy transaction with one memo instruction, paid and signed by `signer`. */
export function memoTransaction(signer: Signer, recentBlockhash: string, memo: string): { tx: Uint8Array; message: Uint8Array } {
  const data = new TextEncoder().encode(memo);
  const blockhash = b58decode(recentBlockhash);
  if (blockhash.length !== 32) throw new Error("bad blockhash");
  const message = Uint8Array.from([
    1, 0, 1, // one signer, no read-only signers, one read-only unsigned account (the memo program)
    ...compactU16(2), ...signer.publicKey, ...b58decode(MEMO_PROGRAM),
    ...blockhash,
    ...compactU16(1), 1, ...compactU16(0), ...compactU16(data.length), ...data,
  ]);
  const signature = sign(null, message, signer.key);
  return { tx: Uint8Array.from([...compactU16(1), ...signature, ...message]), message };
}

export function publicKeyObject(pub: Uint8Array): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(pub) }, format: "jwk" });
}
