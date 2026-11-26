// Anchor the latest audit on Solana: one memo carrying the SHA-256 of the day's raw
// evidence and of its report. Anyone can recompute both and compare with the chain.
// Usage: node src/anchor.ts [--out results]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./audit.ts";
import { anchorMemo } from "./chain.ts";

const outDir = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "results";
const report = JSON.parse(readFileSync(join(outDir, "latest.json"), "utf8"));
const day = String(report.startedAt).slice(0, 10);
const reportHash = sha256(readFileSync(join(outDir, `${day}.json`), "utf8"));
const rawHash = sha256(readFileSync(join(outDir, report.evidence.file), "utf8"));
if (rawHash !== report.evidence.sha256) throw new Error("raw evidence does not match the hash in its report");
const memo = `verity v1 ${day} raw=${rawHash} report=${reportHash}`;

const receipt = await anchorMemo(memo);
mkdirSync(join(outDir, "anchors"), { recursive: true });
writeFileSync(join(outDir, "anchors", `${day}.json`), JSON.stringify({
  day, ...receipt, memo, rawSha256: rawHash, reportSha256: reportHash, anchoredAt: new Date().toISOString(),
}, null, 2));
console.log(`Anchored ${day} on ${receipt.cluster}: ${receipt.explorer}`);
