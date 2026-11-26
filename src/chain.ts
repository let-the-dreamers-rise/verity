import { readFileSync } from "node:fs";
// Post a memo to Solana over JSON-RPC. Defaults to devnet with a fresh key funded by
// the faucet, so it needs no setup; SOLANA_RPC and SOLANA_SECRET_KEY switch to a funded key.
import { b58encode, memoTransaction, signerFrom } from "./solana.ts";

export interface MemoReceipt { cluster: string; signature: string; signer: string; explorer: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postMemo(memo: string): Promise<MemoReceipt> {
  const rpcUrl = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
  const cluster = rpcUrl.includes("devnet") ? "devnet" : rpcUrl.includes("testnet") ? "testnet" : "mainnet-beta";

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

  const secret = process.env.SOLANA_SECRET_KEY ? JSON.parse(process.env.SOLANA_SECRET_KEY) : undefined;
  const signer = signerFrom(secret);
  const payer = b58encode(signer.publicKey);

  const balance = (await rpc("getBalance", [payer, { commitment: "confirmed" }])).value as number;
  if (balance < 10_000) {
    if (cluster === "mainnet-beta") throw new Error(`the key ${payer} has no SOL for fees`);
    let funded = false;
    for (let attempt = 1; attempt <= 4 && !funded; attempt++) {
      try {
        funded = await confirmed(await rpc("requestAirdrop", [payer, 10_000_000]), 40);
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
  return { cluster, signature, signer: payer, explorer };
}

/**
 * Anchor through the Verity listener when running in GitHub Actions: the listener holds
 * the funded signing key and accepts only this repository's main-branch workflow,
 * proven by a GitHub OIDC token. Elsewhere, sign locally with postMemo.
 */
function configuredListener(): string {
  if (process.env.VERITY_LISTENER) return process.env.VERITY_LISTENER;
  try { return JSON.parse(readFileSync("canary.json", "utf8")).listener ?? ""; } catch { return ""; }
}

export async function anchorMemo(memo: string, listener = configuredListener()): Promise<MemoReceipt> {
  const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!listener || !reqUrl || !reqToken) return postMemo(memo);
  const idToken = await fetch(`${reqUrl}&audience=verity-listener`, { headers: { authorization: `bearer ${reqToken}` } })
    .then((r) => r.json() as Promise<{ value: string }>);
  const res = await fetch(`${listener.replace(/\/$/, "")}/__verity/anchor`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken.value}` },
    body: JSON.stringify({ memo }),
    signal: AbortSignal.timeout(90_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`listener refused to anchor: ${body.error ?? res.status}`);
  return body as MemoReceipt;
}
