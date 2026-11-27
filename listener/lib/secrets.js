// The listener's secrets are made by the listener itself on first use and kept in its
// private Blob store, so they never pass through a laptop, a chat or the repository.
// - solanaSecretKey: 64-byte ed25519 key that signs Verity's Solana memos
// - adminToken: unlocks /__verity/hits/<token>; readable by the project owner in the
//   Vercel dashboard (Storage, the blob "secrets/listener.json")
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { get, put } from "@vercel/blob";

const PATH = "secrets/listener.json";
let cached;

async function read() {
  const r = await get(PATH, { access: "private", useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

function fresh() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { solanaSecretKey: [...d, ...x], adminToken: randomBytes(24).toString("base64url"), createdAt: new Date().toISOString() };
}

export async function secrets() {
  if (cached) return cached;
  let s = await read();
  if (!s) {
    try {
      // allowOverwrite is false by default: if two cold starts race, the second put fails
      // and both use whichever key was written first.
      await put(PATH, JSON.stringify(fresh()), { access: "private", contentType: "application/json", addRandomSuffix: false });
    } catch { /* written by a concurrent request */ }
    s = await read();
  }
  if (!s) throw new Error("could not load or create listener secrets");
  return (cached = s);
}
