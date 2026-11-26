import assert from "node:assert/strict";
import { test } from "node:test";
import { runAudit, sha256, shuffled } from "../src/audit.ts";
import { defaultProbes } from "../src/probes.ts";
import type { Endpoint } from "../src/types.ts";

const probes = defaultProbes();

function endpoint(id: string, keyEnv = "K"): Endpoint {
  return { id, host: id, via: "direct", baseUrl: `http://${id}.test/v1`, keyEnv, model: "m", modelName: "m" };
}

/** A fake host. "padder" bills 40% more tokens and never calls tools. */
function fakeFetch(calls: string[]): typeof fetch {
  return (async (url: any, init: any) => {
    const host = new URL(String(url)).hostname.split(".")[0];
    calls.push(host);
    const body = JSON.parse(init.body);
    const user = body.messages.at(-1).content as string;
    let message: any = { content: "A normal answer.\n[END]" };
    let tokens = 12;
    const echo = /<<<\n([\s\S]*)\n>>>/.exec(user);
    if (echo) {
      message = { content: echo[1] };
      tokens = Math.ceil(echo[1].length / 4);
    } else if (body.tools && host !== "padder") {
      const want = probes.find((p) => p.messages.at(-1)!.content === user)?.expectTool;
      const args = want === "get_weather"
        ? { name: "get_weather", arguments: JSON.stringify({ city: "X", unit: "celsius" }) }
        : want === "create_ticket"
          ? { name: "create_ticket", arguments: JSON.stringify({ title: "t", priority: "low", tags: ["a"] }) }
          : { name: "schedule_meeting", arguments: JSON.stringify({ topic: "t", duration_minutes: 30, attendees: ["a@b.c"] }) };
      message = { content: null, tool_calls: [{ function: args }] };
    }
    if (host === "padder") tokens = Math.round(tokens * 1.4);
    return new Response(JSON.stringify({
      model: "m", choices: [{ finish_reason: "stop", message }],
      usage: { prompt_tokens: 9, completion_tokens: tokens },
    }), { status: 200 });
  }) as typeof fetch;
}

test("runAudit calls every probe on every keyed endpoint and flags the padder", async () => {
  const calls: string[] = [];
  const eps = [endpoint("alpha"), endpoint("beta"), endpoint("gamma"), endpoint("padder"), endpoint("nokey", "MISSING")];
  const { report, observations } = await runAudit(eps, probes, {
    delayMs: 0, fetchImpl: fakeFetch(calls), getKey: (n) => (n === "K" ? "secret" : undefined),
  });
  assert.equal(observations.length, 4 * probes.length);
  assert.equal(calls.includes("nokey"), false);
  assert.equal(report.endpoints.length, 4);
  const padder = report.endpoints.find((e) => e.endpointId === "padder")!;
  const alpha = report.endpoints.find((e) => e.endpointId === "alpha")!;
  assert.deepEqual(alpha.flags, []);
  assert.ok(padder.tokenRatio! > 1.3);
  assert.ok(padder.flags.includes("bills more tokens than peers"));
  assert.ok(padder.flags.includes("tool calls failing"));
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.equal(JSON.stringify(observations).includes("secret"), false);
});

test("runAudit records failures instead of throwing", async () => {
  const failing = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
  const { report } = await runAudit([endpoint("down")], probes.slice(0, 3), {
    delayMs: 0, fetchImpl: failing, getKey: () => "k",
  });
  assert.equal(report.endpoints[0].availability, 0);
  assert.ok(report.endpoints[0].flags.includes("low availability"));
  assert.ok(report.caveats.some((c) => c.includes("only 1 host")));
});

test("shuffled is deterministic and keeps every item", () => {
  const a = shuffled([1, 2, 3, 4, 5, 6], 42);
  assert.deepEqual(a, shuffled([1, 2, 3, 4, 5, 6], 42));
  assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5, 6]);
  assert.notDeepEqual(a, shuffled([1, 2, 3, 4, 5, 6], 43));
});

test("sha256 matches a known vector", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("an endpoint refused on every call is reported as not measured, not as a bad host", async () => {
  const refused = (async () => new Response(
    JSON.stringify({ error: { message: "model not supported" }, user_id: "user_private" }), { status: 400 },
  )) as typeof fetch;
  const { report, observations } = await runAudit([endpoint("wrong")], probes.slice(0, 3), {
    delayMs: 0, fetchImpl: refused, getKey: () => "k",
  });
  assert.equal(report.endpoints.length, 0);
  assert.ok(report.caveats.some((c) => c.includes("not measured") && c.includes("model not supported")));
  assert.equal(JSON.stringify(observations).includes("user_private"), false);
});
