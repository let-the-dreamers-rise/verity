// Plain-JS copy of src/solana.ts and src/chain.ts for the listener, which deploys on
// its own. Posts a memo signed by the key in SOLANA_SECRET_KEY.
import { createPrivateKey, sign } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
function b58decode(text) {
  let n = 0n;
  for (const c of text) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error("not base58"); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
function compactU16(n) {
  const out = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n === 0) { out.push(b); return out; } out.push(b | 0x80); }
}

export function signerFromEnv() {
  const secret = JSON.parse(process.env.SOLANA_SECRET_KEY);
  const seed = Buffer.from(secret.slice(0, 32)).toString("base64url");
  const pub = Uint8Array.from(secret.slice(32));
  const key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: seed, x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
  return { publicKey: pub, key, address: b58encode(pub) };
}

export async function postMemo(memo) {
  const rpcUrl = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
  const cluster = rpcUrl.includes("devnet") ? "devnet" : rpcUrl.includes("testnet") ? "testnet" : "mainnet-beta";
  const rpc = async (method, params) => {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  };
  const signer = signerFromEnv();
  const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  const data = new TextEncoder().encode(memo);
  const message = Uint8Array.from([
    1, 0, 1,
    ...compactU16(2), ...signer.publicKey, ...b58decode(MEMO_PROGRAM),
    ...b58decode(blockhash),
    ...compactU16(1), 1, ...compactU16(0), ...compactU16(data.length), ...data,
  ]);
  const tx = Uint8Array.from([...compactU16(1), ...sign(null, message, signer.key), ...message]);
  const signature = await rpc("sendTransaction", [Buffer.from(tx).toString("base64"), { encoding: "base64" }]);
  for (let i = 0; i < 30; i++) {
    const s = (await rpc("getSignatureStatuses", [[signature]]))?.value?.[0];
    if (s?.err) throw new Error(`transaction failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      const explorer = `https://explorer.solana.com/tx/${signature}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;
      return { cluster, signature, signer: signer.address, explorer };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`transaction ${signature} not confirmed in time`);
}
