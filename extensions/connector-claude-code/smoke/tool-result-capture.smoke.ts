/**
 * Claude connector capture through the shipped mapper (no NATS) — run with:
 *   pnpm --dir extensions/connector-claude-code exec tsx smoke/tool-result-capture.smoke.ts
 *
 * The connector's own transcript records go through the shipped createClaudeMapper, wrapped by
 * captureToolResults: the journal holds the result under Claude's native tool_use id, the batch
 * the emitter receives is unchanged, and an unrelated id stays missing.
 */
import assert from "node:assert/strict";
import { ToolResultJournal, captureToolResults } from "@cotal-ai/connector-core";
import { createClaudeMapper, type ClaudeEntry } from "../src/agui-map.js";

let checks = 0;
const ok = (value: unknown, message: string): void => { assert.ok(value, message); checks++; };

const THREAD = "5a1b2c3d-claude-session";
const HOLDER = "u_owner.web";
const journal = new ToolResultJournal();
// Capture starts only under an applied consent (verified by the consent command in production).
journal.applyConsent({ id: "consent-0123456789ab", holder: { id: HOLDER }, exp: Number.MAX_SAFE_INTEGER, issuer: { keyId: "host" }, iat: 0 });
const mapper = createClaudeMapper({ threadId: THREAD, mintRunId: () => "run-new", resumeRunId: "run-open", now: () => 0 });
const map = captureToolResults(mapper.map, journal, THREAD);

const call = map({
  type: "assistant",
  uuid: "assistant-tool-use",
  timestamp: "2026-10-18T09:00:00.000Z",
  message: { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_01CANARY", name: "Bash", input: { command: "echo canary" } }] },
} as ClaudeEntry);
ok(call !== null && "events" in call, "the tool_use record maps to a batch");
ok(journal.answer(THREAD, "toolu_01CANARY", HOLDER).state === "pending", "the native tool_use id is pending before its result");

const done = map({
  type: "user",
  uuid: "user-tool-result",
  timestamp: "2026-10-18T09:00:01.000Z",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_01CANARY", content: "canary\n" }] },
} as ClaudeEntry);
ok(done !== null && "events" in done && done.events.some((e) => e.type === "TOOL_CALL_RESULT"), "the emitter still receives the result event, which its egress fence withholds");
const got = journal.answer(THREAD, "toolu_01CANARY", HOLDER);
ok(got.state === "available" && got.content === "canary\n" && got.toolCallId === "toolu_01CANARY", "the journal holds the result under Claude's own id");
ok(journal.answer(THREAD, "toolu_01OTHER", HOLDER).state === "missing", "no nearest-call correlation: another id is missing");

console.log(`tool-result-capture smoke: ${checks} checks passed`);
