// Verity bait listener. Every probe Verity sends carries one-time tokens that point
// here. Only someone who saw the prompt can know a token, and Verity publishes only
// sha256(token) before sending, so any request carrying a token whose hash is in the
// public seed list is evidence that the prompt left the host it was sent to.
//
// Stores each token-bearing request privately in Vercel Blob. Public: /status (counts
// only). Private: /__verity/hits/<admin token>, the full join of hits and seeds.
import { createHash, timingSafeEqual } from "node:crypto";
import { get, list, put } from "@vercel/blob";
import { verifyGithubToken } from "../lib/oidc.js";
import { postMemo, signerFrom } from "../lib/solana.js";
import { secrets } from "../lib/secrets.js";

const TOKEN = /[A-Za-z0-9_-]{22}/g;
const KEY = /(?:tdp|vrt)_live_([A-Za-z0-9_-]{22})/g;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function tokensIn(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(KEY)) out.add(m[1]);
  for (const m of String(text ?? "").matchAll(TOKEN)) out.add(m[0]);
  return [...out];
}

async function isAdmin(got) {
  const want = (await secrets()).adminToken;
  if (!want || !got || want.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

const SEEDS_BASE = process.env.VERITY_SEEDS_BASE || "https://let-the-dreamers-rise.github.io/verity/data/canary/";

/** The public seed list: only sha256 of each token, with the route it was sent to. */
async function publicSeeds() {
  const index = await fetch(SEEDS_BASE + "index.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { runs: [] }));
  const seeds = [];
  for (const run of index.runs ?? []) {
    const file = await fetch(SEEDS_BASE + "seeds/" + run + ".json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    for (const s of file?.seeds ?? []) seeds.push({ ...s, run });
  }
  return seeds;
}

/** Join stored hits with public seeds: which seeds fired, when first, and from where. */
function match(seeds, hits) {
  const byHash = new Map();
  for (const s of seeds) for (const h of [s.urlCommitment, s.keyCommitment]) if (h) byHash.set(h, s);
  const fired = new Map();
  for (const hit of hits) {
    for (const t of hit.tokens) {
      const seed = byHash.get(t.hash);
      if (!seed) continue;
      const key = seed.urlCommitment;
      const prev = fired.get(key) ?? { seed, hits: [] };
      prev.hits.push({ at: hit.at, via: t.via, ip: hit.ip, country: hit.country, city: hit.city, userAgent: hit.userAgent, token: t.token });
      fired.set(key, prev);
    }
  }
  return [...fired.values()];
}

async function allHits() {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: "hits/", cursor, limit: 1000 });
    for (const b of page.blobs) {
      const r = await get(b.pathname, { access: "private", useCache: false });
      if (r && r.statusCode === 200) out.push(JSON.parse(await new Response(r.stream).text()));
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.searchParams.get("__p") ?? url.pathname;
  url.searchParams.delete("__p");
  const query = url.searchParams.toString();

  if (path === "/__verity/anchor") {
    // Signs a Solana memo for Verity's own workflow, proven by its GitHub OIDC token.
    if (req.method === "GET") {
      try { return res.status(200).json({ signer: signerFrom((await secrets()).solanaSecretKey).address, cluster: process.env.SOLANA_RPC?.includes("devnet") ? "devnet" : "mainnet-beta" }); }
      catch (err) { return res.status(503).json({ error: err instanceof Error ? err.message : "no signing key" }); }
    }
    try {
      await verifyGithubToken(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), {
        audience: "verity-listener", repository: "let-the-dreamers-rise/verity", ref: "refs/heads/main",
      });
    } catch (err) {
      return res.status(401).json({ error: err instanceof Error ? err.message : "unauthorized" });
    }
    const memo = String(req.body?.memo ?? "");
    if (!/^verity [ -~]{10,400}$/.test(memo)) return res.status(400).json({ error: "memo must start with 'verity ' and be printable ASCII" });
    try { return res.status(200).json(await postMemo(memo, signerFrom((await secrets()).solanaSecretKey))); }
    catch (err) { return res.status(502).json({ error: err instanceof Error ? err.message : String(err) }); }
  }
  if (path.startsWith("/__verity/hits/")) {
    if (!(await isAdmin(path.slice("/__verity/hits/".length)))) return res.status(404).send("Not found");
    const [seeds, hits] = await Promise.all([publicSeeds(), allHits()]);
    return res.status(200).json({ seeds: seeds.length, hitsStored: hits.length, fired: match(seeds, hits), hits });
  }
  if (path === "/check") {
    // For Verity Monitor users: which of these bait hashes have come back? Hashes are
    // the user's own commitments, so the details of their own bait are theirs to see.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("cache-control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "POST {\"hashes\": [...]}" });
    const wanted = new Set((Array.isArray(req.body?.hashes) ? req.body.hashes : []).filter((h) => /^[0-9a-f]{64}$/.test(h)).slice(0, 2000));
    if (wanted.size === 0) return res.status(400).json({ error: "hashes must be a list of sha256 hex strings" });
    const agg = new Map();
    for (const hit of await allHits()) for (const t of hit.tokens) {
      if (!wanted.has(t.hash)) continue;
      const a = agg.get(t.hash) ?? { hash: t.hash, firstAt: hit.at, lastAt: hit.at, count: 0, via: new Set(), countries: new Set(), userAgents: new Set() };
      a.count++; a.lastAt = hit.at; a.via.add(t.via);
      if (hit.country) a.countries.add(hit.country);
      if (hit.userAgent) a.userAgents.add(String(hit.userAgent).slice(0, 200));
      agg.set(t.hash, a);
    }
    const fired = [...agg.values()].map((a) => ({ ...a, via: [...a.via], countries: [...a.countries], userAgents: [...a.userAgents].slice(0, 5) }));
    return res.status(200).json({ checkedAt: new Date().toISOString(), checked: wanted.size, fired });
  }
  if (path === "/status") {
    // Public: counts only. Which route fired stays private until the host has been told.
    const [seeds, hits] = await Promise.all([publicSeeds(), allHits()]);
    const fired = match(seeds, hits);
    const isSelf = (s) => s.endpointId === "verity-selftest";
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({
      service: "verity-listener",
      checkedAt: new Date().toISOString(),
      seeded: seeds.filter((s) => !isSelf(s) && s.delivered).length,
      routes: new Set(seeds.filter((s) => !isSelf(s) && s.delivered).map((s) => s.endpointId)).size,
      fired: fired.filter((f) => !isSelf(f.seed)).length,
      firedRoutes: new Set(fired.filter((f) => !isSelf(f.seed)).map((f) => f.seed.endpointId)).size,
      selftest: { seeded: seeds.filter(isSelf).length, fired: fired.filter((f) => isSelf(f.seed)).length },
      hitsStored: hits.length,
    });
  }

  const auth = String(req.headers.authorization ?? "") + " " + String(req.headers["x-api-key"] ?? "");
  const found = [
    ...tokensIn(path).map((t) => ({ t, via: "path" })),
    ...tokensIn(query).map((t) => ({ t, via: "query" })),
    ...tokensIn(auth).map((t) => ({ t, via: "credential" })),
  ];

  if (found.length > 0) {
    const at = new Date().toISOString();
    const h = req.headers;
    const record = {
      at,
      method: req.method,
      tokens: found.map(({ t, via }) => ({ token: t, hash: sha256(t), via })),
      pathShape: path.replace(TOKEN, "<token>"),
      ip: String(h["x-forwarded-for"] ?? "").split(",")[0].trim() || null,
      country: h["x-vercel-ip-country"] ?? null,
      region: h["x-vercel-ip-country-region"] ?? null,
      city: h["x-vercel-ip-city"] ? decodeURIComponent(String(h["x-vercel-ip-city"])) : null,
      userAgent: h["user-agent"] ?? null,
      referer: h["referer"] ?? null,
      accept: h["accept"] ?? null,
    };
    const name = `hits/${at.slice(0, 10)}/${at}-${found[0].t.slice(0, 6)}-${Math.random().toString(36).slice(2, 8)}.json`;
    try {
      await put(name, JSON.stringify(record), { access: "private", contentType: "application/json", addRandomSuffix: false });
    } catch (err) {
      console.error("store failed", err instanceof Error ? err.message : err);
    }
  }

  // Look like an ordinary internal service so a scraper or key tester keeps going.
  if (path.startsWith("/api/")) {
    return res.status(401).json({ error: { code: "invalid_api_key", message: "The API key provided is not valid." } });
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  return res.status(200).send(
    "<!doctype html><title>Sign in</title><body style='font-family:system-ui;margin:4rem'>" +
    "<h1>Sign in required</h1><p>This document is restricted to your workspace.</p></body>",
  );
}
