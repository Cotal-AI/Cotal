/**
 * A Pi seat's tool calls reach the payload rail: each call's arguments as TOOL_CALL_ARGS and its
 * output as TOOL_CALL_RESULT, while the public event channel carries the `cotal.toolResult` marker
 * with the error flag and nothing the tool read or returned. Thinking blocks map to REASONING_*
 * only when the mapper is asked for them.
 *
 * The records are the shapes Pi 1.0.4 wrote for a live `bash` call. They go through Pi's own
 * session source, the shipped mapper and the shared emitter over a fake endpoint, with the call and
 * its result in separate reads as a live seat reads them. No broker is started.
 *
 * Run: pnpm smoke:pi-agui-payloads
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "@cotal-ai/core";
import { AguiEmitter, EventWal, TOOL_RESULT_EVENT, type AguiEvent, type EmitterEndpoint } from "@cotal-ai/connector-core";
import { emitSentinel, memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import { createPiMapper, type PiSessionEntry } from "../src/agui-map.js";
import { PiSessionSource } from "../src/agui-source.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

const line = (entry: PiSessionEntry): string => `${JSON.stringify(entry)}\n`;
const assistant = (id: string, ts: number, content: unknown[], stopReason: string): PiSessionEntry =>
  ({ type: "message", id, timestamp: new Date(ts).toISOString(), message: { role: "assistant", content, stopReason, timestamp: ts } }) as PiSessionEntry;
const toolResult = (id: string, ts: number, toolCallId: string, text: string, isError: boolean): PiSessionEntry =>
  ({ type: "message", id, timestamp: new Date(ts).toISOString(), message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: ts } }) as PiSessionEntry;
const events = (parts: Part[]): AguiEvent[] => parts.flatMap((p) => ((p as unknown as { events?: AguiEvent[] }).events ?? []));

console.log("Pi tool payloads through the shared emitter");
{
  const root = mkdtempSync(join(tmpdir(), "cotal-pi-payloads-"));
  try {
    mkdirSync(join(root, "thread"));
    const path = join(root, "session.jsonl");
    writeFileSync(path, "");
    const published: { rail: "public" | "payload"; parts: Part[] }[] = [];
    const ep: EmitterEndpoint = {
      principal: { owner: "local", actor: "seat" }, actorIsEphemeral: false, maxPayload: 100_000,
      assertExpectationSemantics: async () => {}, eventPayloadLimit: async () => 100_000,
      encodedSize: (o) => Buffer.byteLength(JSON.stringify(o)) + 100,
      multicastExpecting: async (o) => { published.push({ rail: "public", parts: o.parts }); return { ack: { seq: published.length, duplicate: false } }; },
      publishEventPayload: async (o) => { published.push({ rail: "payload", parts: o.parts }); return { ack: { seq: published.length, duplicate: false } }; },
    };
    const wal = await EventWal.open(join(root, "thread", "wal.json"), { space: "pi", threadId: "native", principal: "local.seat", subjectMayExist: false });
    const emitter = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source: new PiSessionSource(path), map: createPiMapper("native") });
    await emitter.pump();

    const ts = 1_795_432_945_229;
    appendFileSync(path, line(assistant("call-turn", ts, [{ type: "toolCall", id: "toolu_ok", name: "bash", arguments: { command: "echo pi-was-here" } }], "toolUse")));
    await emitter.pump();
    appendFileSync(path, line(toolResult("ok-result", ts + 1, "toolu_ok", "pi-was-here\n", false)) +
      line(assistant("fail-turn", ts + 2, [{ type: "toolCall", id: "toolu_fail", name: "bash", arguments: { command: "false" } }], "toolUse")));
    let threw: unknown;
    try {
      await emitter.pump();
      appendFileSync(path, line(toolResult("fail-result", ts + 3, "toolu_fail", "(no output)\n\nCommand exited with code 1", true)) +
        line(assistant("answer", ts + 4, [{ type: "text", text: "done" }], "stop")));
      await emitter.pump();
    } catch (e) {
      threw = e;
    }
    check("a result read after its call's read publishes without error", threw === undefined, String(threw));

    const rail = published.filter((p) => p.rail === "payload").flatMap((p) => events(p.parts));
    const pub = published.filter((p) => p.rail === "public").flatMap((p) => events(p.parts));
    const args = (id: string) => rail.find((e) => e.type === "TOOL_CALL_ARGS" && (e as { toolCallId?: string }).toolCallId === id) as { delta?: string } | undefined;
    const result = (id: string) => rail.find((e) => e.type === "TOOL_CALL_RESULT" && (e as { toolCallId?: string }).toolCallId === id) as { content?: string; cotal?: { isError?: boolean } } | undefined;
    check("the payload rail carries the bash call's arguments as JSON", args("toolu_ok")?.delta === JSON.stringify({ command: "echo pi-was-here" }), rail);
    check("the payload rail carries the bash call's output text", result("toolu_ok")?.content === "pi-was-here\n", result("toolu_ok"));
    check("a failed call's result says it failed", result("toolu_fail")?.cotal?.isError === true && result("toolu_ok")?.cotal?.isError === false,
      [result("toolu_ok")?.cotal, result("toolu_fail")?.cotal]);
    const markers = pub.filter((e) => e.type === "CUSTOM" && (e as { name?: string }).name === TOOL_RESULT_EVENT).map((e) => (e as { value?: unknown }).value);
    check("the public channel marks each finished call with its error flag",
      JSON.stringify(markers) === JSON.stringify([{ toolCallId: "toolu_ok", isError: false }, { toolCallId: "toolu_fail", isError: true }]), markers);
    const text = JSON.stringify(published.filter((p) => p.rail === "public"));
    check("the public channel carries no tool input or output", !text.includes("TOOL_CALL_ARGS") && !text.includes("TOOL_CALL_RESULT") &&
      !text.includes("pi-was-here") && !text.includes("exited with code"));
    check("the run closes once its last answer is read", pub.at(-1)?.type === "RUN_FINISHED", pub.map((e) => e.type));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("Pi thinking blocks");
{
  const entry = assistant("think-turn", 1_795_432_945_229, [
    { type: "thinking", thinking: "Check the file first.", thinkingSignature: "sig" },
    { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
    { type: "text", text: "answer" },
  ], "stop");
  const types = (reasoning?: boolean) => (createPiMapper("think", undefined, [], reasoning)(entry) as { events: AguiEvent[] } | null)?.events ?? [];
  check("thinking is not published by default", !types().some((e) => e.type.startsWith("REASONING")), types().map((e) => e.type));
  const on = types(true).filter((e) => e.type === "REASONING_MESSAGE_CONTENT").map((e) => (e as { delta?: string }).delta);
  check("the reasoning option publishes thinking, and never a redacted placeholder", JSON.stringify(on) === JSON.stringify(["Check the file first."]), on);
}

console.log(`\n${failed === 0 ? "PI-AGUI-PAYLOADS SMOKE OK" : "PI-AGUI-PAYLOADS SMOKE FAILED"}  (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
