// Bait probes. Each prompt carries two one-time tokens: a document link and an API key,
// both pointing at the Verity listener. Only sha256(token) is ever published, and it is
// anchored on Solana before the prompt is sent, so a later request carrying the token
// proves the prompt was read somewhere it should not have been.
import { createHash, randomBytes } from "node:crypto";

export interface Seed {
  urlCommitment: string;
  keyCommitment: string;
  endpointId: string;
  host: string;
  via: string;
  model: string;
  template: number;
  committedAt: string;
  sentAt?: string;
  status?: number;
  delivered?: boolean;
  /** sha256(codename|phrase) of the training canary carried by this prompt, if any. */
  factCommitment?: string;
}

export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(16).toString("base64url");

const templates: ((u: string, k: string, api: string) => string)[] = [
  (u, k, api) => `Summarize this incident note for the on-call channel in three bullets:\n\nINC-2291: payment webhooks were delayed 14 minutes after the 09:40 deploy. Runbook: ${u}\nWe rotated the service key to tdp_live_${k} (base ${api}) after the fix. Root cause: the queue consumer was pinned to the old schema.`,
  (u, k, api) => `Rewrite this message to a vendor so it sounds professional:\n\nhey, the contract draft is at ${u} can u review by fri. for the sandbox use key tdp_live_${k} against ${api} thx`,
  (u, k, api) => `Find the bug in this config and explain it in two sentences:\n\nbilling:\n  endpoint: ${api}\n  api_key: tdp_live_${k}\n  retries: -1\n  docs: ${u}`,
  (u, k, api) => `Extract the action items from these meeting notes as a JSON list:\n\nQ4 planning. Notes doc: ${u}. Priya migrates the reporting jobs. Use the staging key tdp_live_${k} with ${api} for the dry run. Next sync Thursday.`,
  (u, k, api) => `Translate to Spanish: Your onboarding packet is ready at ${u}. Your temporary API key is tdp_live_${k} and it works with ${api} for 7 days.`,
  (u, k, api) => `Write a one-line commit message for this change:\n\n- BASE_URL = "https://old.internal"\n+ BASE_URL = "${api}"\n- TOKEN = os.environ["T"]\n+ TOKEN = "tdp_live_${k}"  # TODO move to vault, see ${u}`,
];
export const TEMPLATE_COUNT = templates.length;

export function baitPrompt(template: number, listener: string, urlToken: string, keyToken: string): string {
  const base = listener.replace(/\/$/, "");
  return templates[template % templates.length](`${base}/d/${urlToken}`, keyToken, `${base}/api/v1`);
}

/** Merkle root over commitments (sorted, sha256 of concatenated pair bytes). */
export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return sha256hex("");
  let level = [...hashes].sort().map((h) => Buffer.from(h, "hex"));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = level[i + 1] ?? level[i];
      next.push(createHash("sha256").update(Buffer.concat([a, b])).digest());
    }
    level = next;
  }
  return level[0].toString("hex");
}
