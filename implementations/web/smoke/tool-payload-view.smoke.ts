import { closeDom } from "./dom-globals.js";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { WorkList } from "../client/src/ui/work/WorkList.tsx";
import { ToolPayloads } from "../client/src/ui/work/ToolPayloads.tsx";
import { agentEventsPage, classifyTap } from "../src/web.js";
import assert from "node:assert/strict";
import { foldWork } from "../client/src/lib/session.js";
import { payloadText } from "../client/src/lib/toolPayload.js";

const events = [
  { type: "TOOL_CALL_START", toolCallId: "a", toolCallName: "Read" },
  { type: "TOOL_CALL_ARGS", toolCallId: "a", delta: '{"path":' },
  { type: "TOOL_CALL_ARGS", toolCallId: "a", delta: '"hello"}' },
  { type: "TOOL_CALL_RESULT", toolCallId: "a", content: "<script>unsafe</script>" },
];
const work = foldWork([{ id: "f", ts: 1, events, live: true }], []);
const tools = work.items.find(i => i.kind === "tools");
assert.ok(tools?.kind === "tools");
assert.equal(tools.calls[0]?.input, '{"path":"hello"}');
assert.equal(tools.calls[0]?.result, "<script>unsafe</script>");
assert.equal(payloadText(JSON.stringify({ cotalPayloadCut: true, originalBytes: 90000, sha256: "a".repeat(64) })), `Omitted: 90000 bytes, SHA-256 ${"a".repeat(64)}`);
assert.match(payloadText("x".repeat(40000)), /Display cut/);
assert.equal(payloadText(""), "(empty)");
const html = renderToString(createElement(ToolPayloads, { call: tools.calls[0]! }));
const root = document.createElement("div");
root.innerHTML = html;
assert.equal(root.querySelectorAll("details").length, 2);
assert.equal(root.querySelectorAll("details[open]").length, 0);
assert.equal(root.querySelector("script"), null);
assert.match(root.textContent ?? "", /<script>unsafe<\/script>/);
const absentHtml = renderToString(createElement(ToolPayloads, { call: { ...tools.calls[0]!, input: undefined, result: undefined } }));
assert.match(absentHtml, /not received/);
assert.match(absentHtml, /withheld or outside the retained window/);
assert.doesNotMatch(absentHtml, /read failed|read refused/);
const message = { channel: "events.local.alice", id: "m", ts: 1, space: "s", from: { id: "local.alice", name: "alice" }, parts: [] };
assert.equal(classifyTap("cotal.s.evp.local.alice", message)?.event, "agent-frame");
assert.equal(classifyTap("cotal.s.evp.local.mallory", message), null);
const reordered = foldWork([{ id: "early", ts: 1, events: [...events.slice(1), events[0]], live: true }], []);
const early = reordered.items.find(i => i.kind === "tools");
assert.ok(early?.kind === "tools");
assert.equal(early.calls[0]?.input, '{"path":"hello"}');
const page = await agentEventsPage({
  channelHistory: async () => [message],
  eventPayloadHistory: async (owner, actor) => {
    assert.equal(`${owner}.${actor}`, "local.alice");
    return [message, { ...message, id: "payload", ts: 2 }];
  },
}, { owner: "local", actor: "alice" }, 10, () => undefined);
assert.ok("frames" in page);
assert.deepEqual(page.frames.map(m => m.id), ["m", "payload"]);
const denied = await agentEventsPage({
  channelHistory: async () => [message],
  eventPayloadHistory: async () => { throw new Error('Permissions Violation for Subscription to "cotal.s.evp.local.alice"'); },
}, { owner: "local", actor: "alice" }, 10, () => undefined);
assert.ok("frames" in denied);
assert.deepEqual(denied.frames.map(m => m.id), ["m"]);
const keepAlive = setInterval(() => {}, 1000);
const failures: string[] = [];
for (const status of ["timeout", "refused", "failed"] as const) {
  try {
    const answer = await agentEventsPage({
      channelHistory: async () => [message],
      eventPayloadHistory: async () => {
        if (status === "timeout") return new Promise(() => {});
        throw new Error(status === "refused" ? 'Permissions Violation for Subscription to "cotal.s.evp.local.alice"' : "private diagnostic token=secret");
      },
    }, { owner: "local", actor: "alice" }, 10, () => undefined, 20);
    assert.ok("frames" in answer);
    assert.deepEqual(answer.frames.map(m => m.id), ["m"]);
    assert.equal((answer as { payloadRead?: { status: string } }).payloadRead?.status, status);
    assert.doesNotMatch(JSON.stringify(answer), /token=secret/);
    const payloadRead = answer.payloadRead;
    assert.ok(payloadRead);
    const call = { ...tools.calls[0]!, result: undefined };
    const failedHtml = renderToString(createElement(ToolPayloads, { call, payloadRead }));
    root.innerHTML = failedHtml;
    assert.match(root.textContent ?? "", status === "refused" ? /Result · read refused/ : /Result · read failed/);
    assert.doesNotMatch(failedHtml, /not received|withheld|token=secret/);
    assert.match(failedHtml, /hello/);
    assert.doesNotMatch(failedHtml, /Input · read/);
    for (const compact of [false, true]) {
      const listHtml = renderToString(createElement(WorkList, {
        work: { ...work, items: [{ ...tools, calls: [call] }] },
        row: { id: "local.alice", name: "alice", status: "idle", ts: 1 },
        nameOf: id => id, compact, payloadRead,
      }));
      root.innerHTML = listHtml;
      assert.match(root.textContent ?? "", /Work metadata is still shown/);
      assert.match(root.textContent ?? "", status === "refused" ? /Result · read refused/ : /Result · read failed/);
    }
  } catch (error) {
    failures.push(`${status}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
clearInterval(keepAlive);
assert.deepEqual(failures, [], "payload read failures preserve metadata and report their typed state");
closeDom();
console.log("tool payload view passed");
