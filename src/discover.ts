// Lists which hosts serve which open models right now, so endpoints.json can be
// written from facts instead of memory. Prints JSON; sends no prompts.
// Usage: node src/discover.ts
async function getJson(url: string, key?: string): Promise<any> {
  const res = await fetch(url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const out: Record<string, unknown> = {};

try {
  const hf = await getJson("https://router.huggingface.co/v1/models", process.env.HF_TOKEN);
  out.huggingface = (hf.data as any[])
    .map((m) => ({
      id: m.id,
      providers: (m.providers ?? [])
        .filter((p: any) => p.status === "live")
        .map((p: any) => `${p.provider}${p.supports_tools ? "+tools" : ""}`),
    }))
    .filter((m) => m.providers.length >= 3)
    .sort((a, b) => b.providers.length - a.providers.length)
    .slice(0, 60);
} catch (err) {
  out.huggingfaceError = String(err);
}

try {
  const or = await getJson("https://openrouter.ai/api/v1/models");
  out.openrouterFree = (or.data as any[])
    .filter((m) => String(m.id).endsWith(":free"))
    .map((m) => `${m.id}${(m.supported_parameters ?? []).includes("tools") ? " +tools" : ""}`);
} catch (err) {
  out.openrouterError = String(err);
}

console.log(JSON.stringify(out));
