// Runs every probe against every endpoint and builds the report.
import { createHash } from "node:crypto";
import { runProbe, type Fetch } from "./client.ts";
import { scoreEndpoints } from "./scorers.ts";
import type { AuditReport, Endpoint, Observation, Probe } from "./types.ts";

export interface RunOptions {
  /** Pause between calls to the same endpoint, to stay inside free-tier rate limits. */
  delayMs?: number;
  fetchImpl?: Fetch;
  getKey?: (envName: string) => string | undefined;
  onProgress?: (done: number, total: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic shuffle so a host cannot rely on probe order, yet a run can be replayed. */
export function shuffled<T>(items: T[], seed: number): T[] {
  const a = [...items];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function runAudit(
  endpoints: Endpoint[], probes: Probe[], opts: RunOptions = {},
): Promise<{ report: AuditReport; observations: Observation[] }> {
  const getKey = opts.getKey ?? ((n: string) => process.env[n]);
  const delayMs = opts.delayMs ?? 1500;
  const startedAt = new Date().toISOString();
  const active = endpoints.filter((e) => getKey(e.keyEnv));
  const total = active.length * probes.length;
  let done = 0;

  // Endpoints run side by side; calls to one endpoint run one at a time.
  const perEndpoint = await Promise.all(
    active.map(async (ep, idx) => {
      const out: Observation[] = [];
      for (const probe of shuffled(probes, 1000 + idx)) {
        out.push(await runProbe(ep, probe, getKey(ep.keyEnv)!, opts.fetchImpl));
        opts.onProgress?.(++done, total);
        if (delayMs > 0) await sleep(delayMs);
      }
      return out;
    }),
  );
  const observations = perEndpoint.flat();
  const scored = scoreEndpoints(active, probes, observations);
  const skipped = scored.filter((sc) => sc.setupError !== null);
  const scores = scored.filter((sc) => sc.setupError === null);

  const caveats = [
    "Thresholds are provisional until a noise band is measured per host.",
    "Only open-weight models are audited; closed models cannot be re-run by a third party.",
    "A flag is a lead to investigate, not proof of wrongdoing.",
  ];
  for (const sc of skipped) caveats.push(`${sc.endpointId}: not measured, the request was refused (${sc.setupError}).`);
  const models = new Set(scores.map((e) => e.model));
  for (const m of models) {
    const n = scores.filter((e) => e.model === m).length;
    if (n < 3) caveats.push(`${m}: only ${n} host(s) audited, so token ratio is not computed (needs 3).`);
  }

  for (const sc of scores) {
    if (sc.rateLimited > 0) caveats.push(`${sc.endpointId}: ${sc.rateLimited} call(s) were rate limited and left out of its scores.`);
  }

  return {
    report: {
      schema: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      probeCount: probes.length,
      endpoints: scores,
      caveats,
    },
    observations,
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
