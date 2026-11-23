/**
 * A Codex tool result read after its call keeps the event plane publishing.
 *
 * Codex writes a `function_call` when the model asks for the tool, then `exec_command_end` and the
 * `function_call_output` once the command ends (the order of a real rollout on this machine). The
 * host flushes on every `itemCompleted`, and the command's item completes with its
 * `exec_command_end`, so the read it starts can end before the output is written. The output then
 * opens the next read. It maps to TOOL_CALL_RESULT alone, which the public fence strips, so with the
 * payload rail on, the emitter needs an earlier public unit of the same run in that read.
 *
 * The records go through the shipped mapper and the shared emitter over a fake endpoint with the
 * payload rail available, first in two reads split as above, then in one read as a control. No
 * broker is started.
 *
 * Run: pnpm smoke:agui-codex-result-split
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "@cotal-ai/core";
import { AguiEmitter, EventWal, JsonlFileSource, type AguiEvent, type EmitterEndpoint } from "@cotal-ai/connector-core";
import { emitSentinel, memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import { createCodexMapper, type CodexRecord } from "../src/agui-map.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

const at = (ms: number) => new Date(Date.UTC(2026, 10, 23, 12, 0, 0, ms)).toISOString();
const line = (r: CodexRecord) => `${JSON.stringify(r)}\n`;
const call: CodexRecord[] = [
  { timestamp: at(0), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
  { timestamp: at(10), type: "response_item", payload: { type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text: "Listing." }] } },
  { timestamp: at(14), type: "response_item", payload: { type: "function_call", call_id: "call_ls", name: "exec_command", arguments: '{"cmd":"ls"}' } },
  { timestamp: at(80), type: "event_msg", payload: { type: "exec_command_end", call_id: "call_ls", exit_code: 0 } },
];
const output: CodexRecord[] = [
  { timestamp: at(81), type: "response_item", payload: { type: "function_call_output", call_id: "call_ls", output: "notes.txt" } },
  { timestamp: at(900), type: "response_item", payload: { type: "message", role: "assistant", id: "m2", content: [{ type: "output_text", text: "done" }] } },
  { timestamp: at(910), type: "event_msg", payload: { type: "task_complete", turn_id: "t1", error: null } },
];

/** Pump each batch as its own read, with the payload rail available. */
async function publish(batches: CodexRecord[][]) {
  const root = mkdtempSync(join(tmpdir(), "cotal-codex-split-"));
  const published: { rail: "public" | "payload"; events: AguiEvent[] }[] = [];
  const events = (parts: Part[]) => parts.flatMap((p) => ((p as unknown as { events?: AguiEvent[] }).events ?? []));
  const ep: EmitterEndpoint = {
    principal: { owner: "local", actor: "seat" }, actorIsEphemeral: false, maxPayload: 100_000,
    assertExpectationSemantics: async () => {}, eventPayloadLimit: async () => 100_000,
    encodedSize: (o) => Buffer.byteLength(JSON.stringify(o)) + 100,
    multicastExpecting: async (o) => { published.push({ rail: "public", events: events(o.parts) }); return { ack: { seq: published.length, duplicate: false } }; },
    publishEventPayload: async (o) => { published.push({ rail: "payload", events: events(o.parts) }); return { ack: { seq: published.length, duplicate: false } }; },
  };
  try {
    mkdirSync(join(root, "thread"));
    const path = join(root, "rollout.jsonl");
    writeFileSync(path, "");
    const frontier = memorySubjectFrontier();
    let run = 0;
    // As the host's holder factory does: the mapper resumes the run the log has open, so a
    // re-establish after a failure reads on from the stored cursor with a fresh mapper.
    const start = async () => {
      const wal = await EventWal.open(join(root, "thread", "wal.json"), { space: "codex", threadId: "thread", principal: "local.seat", subjectMayExist: false });
      const resumeRunId = wal.pending === null ? wal.brackets?.run : wal.pending.brackets.run;
      const mapper = createCodexMapper({ threadId: "thread", mintRunId: () => `run-${++run}`, resumeRunId });
      return AguiEmitter.start<CodexRecord>({ endpoint: ep, wal, subjectFrontier: frontier, source: new JsonlFileSource<CodexRecord>(path), map: mapper.map });
    };
    let emitter = await start();
    await emitter.pump();
    const errors: string[] = [];
    for (const batch of batches) {
      appendFileSync(path, batch.map(line).join(""));
      try {
        await emitter.pump();
      } catch (e) {
        errors.push((e as Error).message);
        emitter = await start();
        await emitter.pump().catch((again: Error) => errors.push(`after re-establish: ${again.message}`));
      }
    }
    return { published, errors };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const result = (p: Awaited<ReturnType<typeof publish>>) =>
  p.published.filter((x) => x.rail === "payload").flatMap((x) => x.events).find((e) => e.type === "TOOL_CALL_RESULT") as { content?: string } | undefined;
const finished = (p: Awaited<ReturnType<typeof publish>>) =>
  p.published.filter((x) => x.rail === "public").flatMap((x) => x.events).some((e) => e.type === "RUN_FINISHED");

console.log("Codex tool result in one read with its call (control)");
const together = await publish([[...call, ...output]]);
check("the result reaches the payload rail", result(together)?.content === "notes.txt", together.errors);
check("the run finishes on the public channel", finished(together));

console.log("Codex tool result in the read after its call");
const split = await publish([call, output]);
check("the read that starts with the result publishes without error", split.errors.length === 0, split.errors);
check("the result reaches the payload rail", result(split)?.content === "notes.txt");
check("the run finishes on the public channel", finished(split));

console.log(`\n${failed === 0 ? "AGUI-CODEX-RESULT-SPLIT SMOKE OK" : "AGUI-CODEX-RESULT-SPLIT SMOKE FAILED"}  (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
