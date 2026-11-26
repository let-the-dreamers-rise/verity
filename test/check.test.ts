import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck } from "../src/check.ts";
import { defaultProbes } from "../src/probes.ts";
import type { Endpoint } from "../src/types.ts";

const ep: Endpoint = { id: "c", host: "c", via: "direct", baseUrl: "http://c.test/v1", keyEnv: "K", model: "m", modelName: "m" };
const probes = defaultProbes().filter((p) => p.kind === "tool" || p.kind === "long");

/** A host that sends array arguments as strings, the failure seen in the first audits. */
function host(stringifyArrays: boolean): typeof fetch {
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const user = body.messages.at(-1).content as string;
    const want = probes.find((p) => p.messages.at(-1)!.content === user)?.expectTool;
    let message: any = { content: "Done.\n[END]" };
    if (want) {
      const list = (xs: string[]) => (stringifyArrays ? JSON.stringify(xs) : xs);
      const args = want === "get_weather" ? { city: "X", unit: "celsius" }
        : want === "create_ticket" ? { title: "t", priority: "low", tags: list(["a"]) }
        : { topic: "t", duration_minutes: 30, attendees: list(["a@b.c"]) };
      message = { content: null, tool_calls: [{ function: { name: want, arguments: JSON.stringify(args) } }] };
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message }], usage: {} }), { status: 200 });
  }) as typeof fetch;
}

test("check passes a host that returns valid calls", async () => {
  const s = await runCheck(ep, probes, "k", { fetchImpl: host(false) });
  assert.equal(s.toolCallsPassed, s.toolCallsScored);
  assert.equal(s.pass, true);
});

test("check fails a host that sends arrays as strings, and says why", async () => {
  const s = await runCheck(ep, probes, "k", { fetchImpl: host(true) });
  assert.equal(s.pass, false);
  assert.ok(s.toolCallsPassed < s.toolCallsScored);
  assert.ok(s.lines.some((l) => !l.pass && l.detail.includes("expected array, got string")));
});
