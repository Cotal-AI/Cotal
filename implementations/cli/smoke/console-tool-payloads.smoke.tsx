import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { AGUI_FRAME_KIND, type CotalEndpoint, type CotalMessage } from "@cotal-ai/core";
import { ConsoleTools, consoleTools, payloadText } from "../src/console/tool-calls.js";
import { ToolCalls } from "../src/console/ui/ToolCalls.js";

let seq = 0;
const message = (events: unknown[], runId = "run") => ({ id: `m${seq++}`, parts: [{ kind: AGUI_FRAME_KIND, protocol: "ag-ui", threadId: "thread", runId, epoch: "epoch", seq, events }] }) as unknown as CotalMessage;
const start = message([{ type: "TOOL_CALL_START", toolCallId: "call", toolCallName: "read_file" }]);
const args = message([{ type: "TOOL_CALL_ARGS", toolCallId: "call", delta: '{"path":"README.md"}' }]);
const result = message([{ type: "TOOL_CALL_RESULT", toolCallId: "call", content: "result body" }]);
const model = new ConsoleTools();
model.ingest(args); model.ingest(start); model.ingest(result); model.ingest(args);
assert.equal(model.calls.size, 1);
assert.equal([...model.calls.values()][0].args, '{"path":"README.md"}');
assert.equal([...model.calls.values()][0].name, "read_file");
model.ingest(message([{ type: "TOOL_CALL_START", toolCallId: "call", toolCallName: "other" }], "other-run"));
assert.equal(model.calls.size, 2, "reused call ids remain separate across runs");
const cut = JSON.stringify({ cotalPayloadCut: true, originalBytes: 500000, sha256: "abc123" });
assert.match(payloadText(cut), /cotalPayloadCut: true.*500000.*abc123/);
model.unavailable(new Error("permission denied"));
assert.equal(model.error, "permission denied");
assert.equal(model.calls.size, 2, "denied payload reads retain metadata");
model.ingest(message([{ type: "TOOL_CALL_RESULT", toolCallId: "large", content: "x".repeat(300000) }]));
assert.match([...model.calls.values()].at(-1)!.result!, /console display limit reached/);

const taps: string[] = [];
const ep = {
  space: "test", tap: (_handler: unknown, opts: { subject: string }) => taps.push(opts.subject),
  channelHistory: async () => [start], eventPayloadHistory: async () => [args, result],
} as unknown as CotalEndpoint;
const cached = consoleTools(ep, "owner", "actor");
assert.equal(consoleTools(ep, "owner", "actor"), cached);
assert.deepEqual(taps, ["cotal.test.evp.owner.actor", "cotal.test.chat.owner.actor.events.owner.actor"]);
await new Promise((resolve) => setTimeout(resolve, 10));
let output = "";
const stdout = new Writable({ write(chunk, _enc, cb) { output += String(chunk); cb(); } }) as NodeJS.WriteStream;
stdout.columns = 120; stdout.rows = 35;
const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
stdin.ref = () => stdin;
stdin.unref = () => stdin;
const app = render(<ToolCalls ep={ep} owner="owner" actor="actor" width={110} height={32} />, { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
const wait = async (text: string) => {
  const deadline = Date.now() + 3000;
  while (!output.includes(text) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(output.includes(text), `screen contains ${text}: ${output}`);
};
try {
  await wait("payloads collapsed");
  assert.ok(!output.includes("README.md"), "arguments initially hidden");
  assert.ok(!output.includes("result body"), "result initially hidden");
  stdin.write("p");
  await wait("README.md"); await wait("result body");
  cached.ingest(message([{ type: "TOOL_CALL_RESULT", toolCallId: "call", content: cut }]));
  await wait("cotalPayloadCut: true"); await wait("500000");
} finally { app.unmount(); stdin.end(); }
console.log("console tool payload smoke passed: correlation, dedup, scoped taps, collapsed display, expansion, cut marker");
