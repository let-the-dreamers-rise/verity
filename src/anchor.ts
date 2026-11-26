// Anchor the latest audit on Solana: one memo transaction carrying the SHA-256 of the
// day's raw evidence and of its report. Once confirmed, the results cannot be quietly
// rewritten, because anyone can recompute both hashes and compare them with the chain.
//
// Defaults to devnet with a fresh key funded by the devnet faucet, so it needs no setup.
// Set SOLANA_RPC and SOLANA_SECRET_KEY (solana-keygen JSON array) to use a funded key.
// Usage: node src/anchor.ts [--out results]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./audit.ts";
import { b58encode, memoTransaction, signerFrom } from "./solana.ts";

const outDir = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "results";
const rpcUrl = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const cluster = rpcUrl.includes("devnet") ? "devnet" : rpcUrl.includes("testnet") ? "testnet" : "mainnet-beta";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

async function confirmed(signature: string, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i += 2) {
    const r = await rpc("getSignatureStatuses", [[signature]]);
    const s = r?.value?.[0];
    if (s?.err) throw new Error(`transaction failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return true;
    await sleep(2000);
  }
  return false;
}

const report = JSON.parse(readFileSync(join(outDir, "latest.json"), "utf8"));
const day = String(report.startedAt).slice(0, 10);
const reportHash = sha256(readFileSync(join(outDir, `${day}.json`), "utf8"));
const rawHash = sha256(readFileSync(join(outDir, report.evidence.file), "utf8"));
if (rawHash !== report.evidence.sha256) throw new Error("raw evidence does not match the hash in its report");
const memo = `verity v1 ${day} raw=${rawHash} report=${reportHash}`;

const secret = process.env.SOLANA_SECRET_KEY ? JSON.parse(process.env.SOLANA_SECRET_KEY) : undefined;
const signer = signerFrom(secret);
const payer = b58encode(signer.publicKey);

const balance = (await rpc("getBalance", [payer, { commitment: "confirmed" }])).value as number;
if (balance < 10_000) {
  if (cluster === "mainnet-beta") throw new Error(`the anchoring key ${payer} has no SOL for fees`);
  let funded = false;
  for (let attempt = 1; attempt <= 4 && !funded; attempt++) {
    try {
      const sig = await rpc("requestAirdrop", [payer, 10_000_000]);
      funded = await confirmed(sig, 40);
    } catch (err) {
      console.error(`airdrop attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
      await sleep(5000 * attempt);
    }
  }
  if (!funded) throw new Error("could not fund a devnet key from the faucet");
}

const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
const { tx } = memoTransaction(signer, blockhash, memo);
const signature = await rpc("sendTransaction", [Buffer.from(tx).toString("base64"), { encoding: "base64" }]);
if (!(await confirmed(signature, 60))) throw new Error(`transaction ${signature} not confirmed in time`);

const explorer = `https://explorer.solana.com/tx/${signature}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;
mkdirSync(join(outDir, "anchors"), { recursive: true });
writeFileSync(join(outDir, "anchors", `${day}.json`), JSON.stringify({
  day, cluster, signature, signer: payer, memo, rawSha256: rawHash, reportSha256: reportHash, explorer,
  anchoredAt: new Date().toISOString(),
}, null, 2));
console.log(`Anchored ${day} on ${cluster}: ${explorer}`);
