import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCompletion } from "../src/client.ts";
import { defaultProbes } from "../src/probes.ts";
import {
  checkToolCall, checkTruncation, median, scoreEndpoints, similarity, tokenRatios, validateSchema,
} from "../src/scorers.ts";
import type { Endpoint, Observation, Probe } from "../src/types.ts";

const probes = defaultProbes();
const toolProbe = probes.find((p) => p.id === "tool-1")!;
const longProbe = probes.find((p) => p.id === "long-1")!;
const echoProbe = probes.find((p) => p.id === "echo-1")!;

function obs(over: Partial<Observation>): Observation {
  return {
    endpointId: "a", probeId: "x", ok: true, status: 200, latencyMs: 100, text: "",
    toolCalls: [], finishReason: "stop", promptTokens: 10, completionTokens: 10,
    reasoningTokens: null, servedModel: null, ...over,
  };
}
function ep(id: string, over: Partial<Endpoint> = {}): Endpoint {
  return { id, host: id, via: "direct", baseUrl: "http://x", keyEnv: "K", model: "m", modelName: "m", ...over };
}

test("validateSchema catches type, required, enum and extra keys", () => {
  const schema = toolProbe.tools![0].function.parameters;
  assert.deepEqual(validateSchema({ city: "Lisbon", unit: "celsius" }, schema), []);
  assert.equal(validateSchema({ city: "Lisbon" }, schema).length, 1);
  assert.equal(validateSchema({ city: "Lisbon", unit: "kelvin" }, schema).length, 1);
  assert.equal(validateSchema({ city: 5, unit: "celsius" }, schema).length, 1);
  assert.equal(validateSchema({ city: "Lisbon", unit: "celsius", x: 1 }, schema).length, 1);
  assert.equal(validateSchema("nope", schema).length, 1);
});

test("validateSchema checks integers and array items", () => {
  const schema = probes.find((p) => p.id === "tool-5")!.tools![2].function.parameters;
  assert.deepEqual(validateSchema({ topic: "t", duration_minutes: 45, attendees: ["a@b.c"] }, schema), []);
  assert.equal(validateSchema({ topic: "t", duration_minutes: 4.5, attendees: [] }, schema).length, 1);
  assert.equal(validateSchema({ topic: "t", duration_minutes: 45, attendees: [1] }, schema).length, 1);
});

test("checkToolCall passes a valid call and fails the common breakages", () => {
  const good = obs({ toolCalls: [{ name: "get_weather", arguments: '{"city":"Lisbon","unit":"celsius"}' }] });
  assert.equal(checkToolCall(good, toolProbe).pass, true);
  assert.equal(checkToolCall(obs({ text: "It is sunny." }), toolProbe).pass, false);
  assert.equal(checkToolCall(obs({ toolCalls: [{ name: "create_ticket", arguments: "{}" }] }), toolProbe).pass, false);
  assert.equal(checkToolCall(obs({ toolCalls: [{ name: "get_weather", arguments: '{"city":"Lis' }] }), toolProbe).pass, false);
  assert.equal(checkToolCall(obs({ toolCalls: [{ name: "get_weather", arguments: '{"city":"Lisbon"}' }] }), toolProbe).pass, false);
  assert.equal(checkToolCall(obs({ ok: false, status: 500 }), toolProbe).pass, false);
});

test("checkTruncation flags empty 200s, length stops and missing end markers", () => {
  assert.equal(checkTruncation(obs({ text: "All good.\n[END]" }), longProbe).pass, true);
  assert.equal(checkTruncation(obs({ text: "   " }), longProbe).pass, false);
  assert.equal(checkTruncation(obs({ text: "Half an ans", finishReason: "length" }), longProbe).pass, false);
  assert.equal(checkTruncation(obs({ text: "Stopped mid thought" }), longProbe).pass, false);
});

test("similarity is 1 for same text, high for near text, low for different text", () => {
  assert.equal(similarity("The sky is  blue.", "the sky is blue."), 1);
  const near = similarity("the sky is blue because air scatters light", "the sky is blue because air scatters sunlight");
  assert.ok(near > 0.7 && near < 1);
  assert.ok(similarity("the sky is blue because air scatters light", "pens cost eight dollars in total today") < 0.1);
  assert.equal(similarity("yes", "no"), 0);
});

test("median handles odd, even and empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("tokenRatios flags the host that bills more for byte-identical output", () => {
  const eps = [ep("a"), ep("b"), ep("c"), ep("d")];
  const text = echoProbe.expectText!;
  const o = [
    obs({ endpointId: "a", probeId: echoProbe.id, text, completionTokens: 20 }),
    obs({ endpointId: "b", probeId: echoProbe.id, text, completionTokens: 20 }),
    obs({ endpointId: "c", probeId: echoProbe.id, text, completionTokens: 20 }),
    obs({ endpointId: "d", probeId: echoProbe.id, text, completionTokens: 30 }),
  ];
  const r = tokenRatios(eps, [echoProbe], o);
  assert.equal(r.get("a"), 1);
  assert.equal(r.get("d"), 1.5);
});

test("tokenRatios skips probes without three identical outputs and ignores non-exact echoes", () => {
  const eps = [ep("a"), ep("b"), ep("c")];
  const text = echoProbe.expectText!;
  const o = [
    obs({ endpointId: "a", probeId: echoProbe.id, text, completionTokens: 20 }),
    obs({ endpointId: "b", probeId: echoProbe.id, text, completionTokens: 40 }),
    obs({ endpointId: "c", probeId: echoProbe.id, text: "Sure! " + text, completionTokens: 22 }),
  ];
  assert.equal(tokenRatios(eps, [echoProbe], o).size, 0);
});

test("tokenRatios compares only hosts of the same model", () => {
  const eps = [ep("a"), ep("b"), ep("c"), ep("z", { model: "other" })];
  const text = echoProbe.expectText!;
  const o = ["a", "b", "c"].map((id) => obs({ endpointId: id, probeId: echoProbe.id, text, completionTokens: 20 }));
  o.push(obs({ endpointId: "z", probeId: echoProbe.id, text, completionTokens: 90 }));
  const r = tokenRatios(eps, [echoProbe], o);
  assert.equal(r.has("z"), false);
  assert.equal(r.get("a"), 1);
});

test("scoreEndpoints produces rates and flags for a bad host and none for a good one", () => {
  const eps = [ep("good"), ep("bad"), ep("peer")];
  const fp: Probe = probes.find((p) => p.kind === "fingerprint")!;
  const used = [toolProbe, longProbe, echoProbe, fp];
  const text = echoProbe.expectText!;
  const goodSet = (id: string) => [
    obs({ endpointId: id, probeId: toolProbe.id, toolCalls: [{ name: "get_weather", arguments: '{"city":"Lisbon","unit":"celsius"}' }] }),
    obs({ endpointId: id, probeId: longProbe.id, text: "A full answer.\n[END]" }),
    obs({ endpointId: id, probeId: echoProbe.id, text, completionTokens: 20 }),
    obs({ endpointId: id, probeId: fp.id, text: "The sky is blue because air scatters short wavelengths. That is called Rayleigh scattering." }),
  ];
  const badSet = [
    obs({ endpointId: "bad", probeId: toolProbe.id, text: "I cannot do that." }),
    obs({ endpointId: "bad", probeId: longProbe.id, text: "" }),
    obs({ endpointId: "bad", probeId: echoProbe.id, text, completionTokens: 31 }),
    obs({ endpointId: "bad", probeId: fp.id, text: "Blue sky happens due to something entirely unrelated to anything said elsewhere here." }),
  ];
  const scores = scoreEndpoints(eps, used, [...goodSet("good"), ...goodSet("peer"), ...badSet]);
  const good = scores.find((s) => s.endpointId === "good")!;
  const bad = scores.find((s) => s.endpointId === "bad")!;
  assert.deepEqual(good.flags, []);
  assert.equal(good.toolCallAccuracy, 1);
  assert.equal(good.truncationRate, 0);
  assert.equal(good.tokenRatio, 1);
  assert.equal(bad.toolCallAccuracy, 0);
  assert.equal(bad.truncationRate, 1);
  assert.equal(bad.tokenRatio, 1.55);
  for (const f of ["tool calls failing", "answers cut off or empty", "bills more tokens than peers", "outputs diverge from peers", "low availability"]) {
    assert.ok(bad.flags.includes(f), `expected flag: ${f}`);
  }
});

test("parseCompletion reads text, tool calls, usage and survives a non-JSON 200", () => {
  const base = obs({ ok: false, status: 0 });
  const parsed = parseCompletion(JSON.stringify({
    model: "served-x",
    choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ function: { name: "f", arguments: "{}" } }] } }],
    usage: { prompt_tokens: 5, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 } },
  }), base);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, "");
  assert.deepEqual(parsed.toolCalls, [{ name: "f", arguments: "{}" }]);
  assert.equal(parsed.completionTokens, 7);
  assert.equal(parsed.reasoningTokens, 3);
  assert.equal(parsed.servedModel, "served-x");
  const broken = parseCompletion("<html>busy</html>", base);
  assert.equal(broken.ok, true);
  assert.equal(broken.text, "");
  assert.match(broken.error!, /not JSON/);
});

test("default probe set is well formed", () => {
  assert.equal(new Set(probes.map((p) => p.id)).size, probes.length);
  for (const p of probes) {
    if (p.kind === "echo") assert.ok(p.expectText);
    if (p.kind === "tool") assert.ok(p.tools?.some((t) => t.function.name === p.expectTool));
    if (p.kind === "long") assert.ok(p.endMarker);
  }
});

test("scoreEndpoints leaves rate-limited calls out of every rate", () => {
  const eps = [ep("a")];
  const o = [
    obs({ endpointId: "a", probeId: longProbe.id, text: "Done.\n[END]" }),
    obs({ endpointId: "a", probeId: toolProbe.id, ok: false, status: 429, text: "" }),
  ];
  const [s] = scoreEndpoints(eps, [toolProbe, longProbe], o);
  assert.equal(s.rateLimited, 1);
  assert.equal(s.probes, 1);
  assert.equal(s.availability, 1);
  assert.equal(s.toolCallAccuracy, null);
  assert.deepEqual(s.flags, []);
});
