import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGUI_EVENT_TYPE } from "@cotal-ai/core";
import {
  AguiEmitter,
  EventWal,
  FileSubjectFrontier,
  JsonlFileSource,
  ensureEventWalDir,
  type AguiFrame,
  type Part,
} from "@cotal-ai/connector-core";
import { createPiMapper, type PiSessionRecord } from "../src/agui-map.js";

let pass = 0;
const check = (condition: unknown, name: string): void => {
  assert.ok(condition, name);
  pass++;
};

const mapper = createPiMapper();
const run = mapper.map({
  type: "custom",
  customType: "cotal-agui",
  data: { version: 1, runId: "run-1", events: [{ type: AGUI_EVENT_TYPE.RUN_STARTED, runId: "run-1", threadId: "session-1", timestamp: 1 }] },
});
check(run?.runId === "run-1", "the persisted turn record opens its named run");

const messageId = "message-observation";
const toolCallId = "native-tool-call";
const payload = mapper.map({
  type: "custom",
  customType: "cotal-agui",
  data: {
    version: 1,
    runId: "run-1",
    events: [
      { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_START, messageId, timestamp: 2, role: "assistant" },
      { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, messageId, delta: "answer", timestamp: 2 },
      { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_END, messageId, timestamp: 2 },
      { type: AGUI_EVENT_TYPE.TOOL_CALL_START, toolCallId, toolCallName: "bash", timestamp: 2 },
      { type: AGUI_EVENT_TYPE.TOOL_CALL_ARGS, toolCallId, delta: "{}", timestamp: 2 },
      { type: AGUI_EVENT_TYPE.TOOL_CALL_END, toolCallId, timestamp: 2 },
      { type: AGUI_EVENT_TYPE.TOOL_CALL_RESULT, messageId: "result-observation", toolCallId, content: "ok", timestamp: 3 },
    ],
  },
});
check(payload?.events.some((event) => (event as { messageId?: string }).messageId === messageId), "assistant events carry messageId");
check(payload?.events.some((event) => (event as { toolCallId?: string }).toolCallId === toolCallId), "tool events carry Pi native toolCallId");

const terminal = mapper.map({
  type: "custom",
  customType: "cotal-agui",
  data: { version: 1, runId: "run-1", events: [{ type: AGUI_EVENT_TYPE.RUN_FINISHED, runId: "run-1", threadId: "session-1", timestamp: 4 }] },
});
check(terminal?.events[0] && (terminal.events[0] as { type: string }).type === AGUI_EVENT_TYPE.RUN_FINISHED, "turn terminal closes the run");

assert.throws(
  () => mapper.map({ type: "custom", customType: "cotal-agui", data: { version: 1, runId: "run-1", events: [] } }),
  /carries no events/,
);
pass++;

// The external observer's view: the shared emitter wraps Pi's persisted records in a frame with
// epoch/seq while retaining the message and native tool-call identities supplied by Pi.
const root = mkdtempSync(join(tmpdir(), "cotal-pi-agui-map-"));
try {
  const session = join(root, "session.jsonl");
  writeFileSync(session, "");
  const principal = "owner.actor";
  const location = await ensureEventWalDir({ workspaceRoot: root, space: "space", principal, threadId: "session-1" });
  try {
    const frontier = await FileSubjectFrontier.open(location.subjectPath, { space: "space", principal });
    const wal = await EventWal.open(location.walPath, { space: "space", threadId: "session-1", principal, subjectMayExist: false });
    const frames: AguiFrame[] = [];
    let tip = 0;
    const emitter = await AguiEmitter.start({
      endpoint: {
        principal: { owner: "owner", actor: "actor" },
        actorIsEphemeral: false,
        maxPayload: 1_000_000,
        async assertExpectationSemantics() {},
        encodedSize({ parts }: { parts: Part[] }) { return Buffer.byteLength(JSON.stringify(parts)); },
        async multicastExpecting({ parts, expectedLastSubjectSeq }: { parts: Part[]; expectedLastSubjectSeq: number }) {
          assert.equal(expectedLastSubjectSeq, tip, "the subject frontier matches the recorded tip");
          frames.push(parts[0] as unknown as AguiFrame);
          tip++;
          return { ack: { seq: tip, duplicate: false } };
        },
      },
      wal,
      subjectFrontier: frontier,
      source: new JsonlFileSource<PiSessionRecord>(session),
      map: createPiMapper().map,
    });
    await emitter.pump(); // adopt the empty session at its complete-line boundary
    appendFileSync(
      session,
      `${JSON.stringify({
        type: "custom",
        customType: "cotal-agui",
        data: {
          version: 1,
          runId: "external-run",
          events: [
            { type: AGUI_EVENT_TYPE.RUN_STARTED, runId: "external-run", threadId: "session-1", timestamp: 5 },
            { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_START, messageId: "external-message", timestamp: 5, role: "assistant" },
            { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, messageId: "external-message", delta: "visible", timestamp: 5 },
            { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_END, messageId: "external-message", timestamp: 5 },
            { type: AGUI_EVENT_TYPE.TOOL_CALL_START, toolCallId: "external-tool", toolCallName: "bash", timestamp: 5 },
            { type: AGUI_EVENT_TYPE.TOOL_CALL_ARGS, toolCallId: "external-tool", delta: "{}", timestamp: 5 },
            { type: AGUI_EVENT_TYPE.TOOL_CALL_END, toolCallId: "external-tool", timestamp: 5 },
            { type: AGUI_EVENT_TYPE.TOOL_CALL_RESULT, messageId: "external-result", toolCallId: "external-tool", content: "ok", timestamp: 5 },
            { type: AGUI_EVENT_TYPE.RUN_FINISHED, runId: "external-run", threadId: "session-1", timestamp: 5 },
          ],
        },
      })}\n`,
    );
    await emitter.pump();
    const frame = frames[0];
    check(frame !== undefined && typeof frame.epoch === "string" && frame.epoch.length > 0, "published frame carries epoch");
    check(frame !== undefined && frame.seq === 1, "published frame carries sequence");
    check(frame.events.some((event) => (event as { messageId?: string }).messageId === "external-message"), "observer receives messageId");
    check(frame.events.some((event) => (event as { toolCallId?: string }).toolCallId === "external-tool"), "observer receives toolCallId");
  } finally {
    await location.lock.release();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`pi AG-UI map smoke: ${pass} passed`);
