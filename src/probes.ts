// The open sample probe set. It is public on purpose, so anyone can reproduce a run.
// Because it is public, a host could tune for it: production runs should add a private,
// rotating set through VERITY_PROBES_FILE (same JSON shape as Probe[]).
import { readFileSync } from "node:fs";
import type { Probe, ToolDef } from "./types.ts";

const echoTexts: string[] = [
  "The quarterly report is due on Friday at 5 PM. Please send your sections to the shared folder before noon.",
  "Order #48213 shipped via ground freight; tracking 1Z999AA10123456784; estimated arrival Tuesday.",
  "def moving_average(xs, n):\n    return [sum(xs[i:i+n]) / n for i in range(len(xs) - n + 1)]",
  "Naïve café owners in Zürich paid €12.50 for 3 kg of jalapeños — a record, said the señor.",
  "SELECT customer_id, SUM(amount) AS total FROM orders WHERE status = 'paid' GROUP BY customer_id ORDER BY total DESC LIMIT 10;",
  "Meeting notes: 1) budget approved 2) launch moved to March 14 3) Priya owns vendor review 4) next sync in two weeks.",
  "Water boils at 100 degrees Celsius at sea level, but at 3,000 metres it boils near 90 degrees.",
  "Reminder: rotate the staging credentials, archive logs older than 30 days, and update the on-call schedule.",
];

const weatherTool: ToolDef = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["city", "unit"],
      additionalProperties: false,
    },
  },
};

const ticketTool: ToolDef = {
  type: "function",
  function: {
    name: "create_ticket",
    description: "Open a support ticket.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "priority", "tags"],
      additionalProperties: false,
    },
  },
};

const transferTool: ToolDef = {
  type: "function",
  function: {
    name: "schedule_meeting",
    description: "Schedule a meeting on the calendar.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string" },
        duration_minutes: { type: "integer" },
        attendees: { type: "array", items: { type: "string" } },
      },
      required: ["topic", "duration_minutes", "attendees"],
      additionalProperties: false,
    },
  },
};

const allTools = [weatherTool, ticketTool, transferTool];

const toolPrompts: { ask: string; tool: string }[] = [
  { ask: "What's the weather in Lisbon right now, in celsius?", tool: "get_weather" },
  { ask: "Is it cold in Chicago today? Use fahrenheit.", tool: "get_weather" },
  { ask: "Our checkout page is returning 500 errors for every customer. Open a high priority ticket and tag it payments and outage.", tool: "create_ticket" },
  { ask: "Please log a low priority ticket: the footer copyright year is out of date. Tag it website.", tool: "create_ticket" },
  { ask: "Book 45 minutes with dana@example.com and li@example.com to review the Q3 roadmap.", tool: "schedule_meeting" },
  { ask: "Set up a 30 minute onboarding call with sam@example.com.", tool: "schedule_meeting" },
];

const longPrompts: string[] = [
  "Write a clear 300 word explanation of how a hash table handles collisions, for a new engineer.",
  "List 15 practical tips for running an effective weekly team meeting, one sentence each.",
  "Explain in about 250 words the difference between a process and a thread, with one everyday analogy.",
  "Draft a polite 200 word email declining a vendor proposal while leaving the door open for next year.",
];

const fingerprintPrompts: string[] = [
  "In exactly two sentences, explain why the sky is blue.",
  "Give the first 12 prime numbers separated by commas, then name the 12th in words.",
  "Translate to French, Spanish and German: 'The train leaves at half past seven.'",
  "Write a four line poem about a lighthouse. Each line must have exactly six words.",
  "Sort these words alphabetically and return them on one line: pear, apple, quince, banana, fig, cherry.",
  "A shop sells pens at 3 for $4. How much do 18 pens cost? Show the working in two short lines.",
];

export const END_MARKER = "[END]";

export function defaultProbes(): Probe[] {
  const probes: Probe[] = [];
  echoTexts.forEach((text, i) =>
    probes.push({
      id: `echo-${i + 1}`,
      kind: "echo",
      messages: [
        { role: "system", content: "You repeat text exactly. Output only the text between the markers, with no quotes and no commentary." },
        { role: "user", content: `Repeat exactly what is between the markers.\n<<<\n${text}\n>>>` },
      ],
      maxTokens: 256,
      expectText: text,
    }));
  toolPrompts.forEach((p, i) =>
    probes.push({
      id: `tool-${i + 1}`,
      kind: "tool",
      messages: [
        { role: "system", content: "You are a helpful assistant. Use a tool when one fits the request." },
        { role: "user", content: p.ask },
      ],
      maxTokens: 256,
      tools: allTools,
      expectTool: p.tool,
    }));
  longPrompts.forEach((ask, i) =>
    probes.push({
      id: `long-${i + 1}`,
      kind: "long",
      messages: [
        { role: "user", content: `${ask}\nFinish your answer with the exact text ${END_MARKER} on its own line.` },
      ],
      maxTokens: 900,
      endMarker: END_MARKER,
    }));
  fingerprintPrompts.forEach((ask, i) =>
    probes.push({
      id: `fp-${i + 1}`,
      kind: "fingerprint",
      messages: [{ role: "user", content: ask }],
      maxTokens: 200,
    }));
  return probes;
}

export function loadProbes(): Probe[] {
  const extra = process.env.VERITY_PROBES_FILE;
  const probes = defaultProbes();
  if (extra) probes.push(...(JSON.parse(readFileSync(extra, "utf8")) as Probe[]));
  return probes;
}
