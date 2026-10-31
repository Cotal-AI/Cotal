import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import React, { useState } from "react";
import { render } from "ink";
import type { MeshSnapshot } from "@cotal-ai/workspace/view";
import type { PsReply } from "../src/console/control.js";
import { runCommand, type CommandCtx } from "../src/console/commands.js";
import { CommandPalette } from "../src/console/ui/CommandPalette.js";

const snapshot = {
  agents: [
    { card: { id: "agent-prefix", name: "alice2", role: "reviewer" }, status: "working" },
    { card: { id: "agent-a", name: "alice", role: "reviewer" }, status: "idle" },
    { card: { id: "agent-b", name: "bob", role: "builder" }, status: "working" },
  ],
  endpoints: [{ card: { id: "endpoint-a", name: "service", role: "worker" }, status: "idle" }],
  channels: [{ channel: "general", messages: 3 }, { channel: "review", messages: 1 }],
} as unknown as MeshSnapshot;
const readManaged = async (): Promise<PsReply> => ({ ok: true,
  rows: [{ name: "managed_only", id: "managed-id", agent: "opencode", mode: "pty", status: "running", mesh: "offline", uptimeMs: 0 }],
  silent: [], failed: [], answered: [],
});
const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
stdin.ref = () => stdin;
stdin.unref = () => stdin;
let frame = "";
const stdout = new Writable({ write(bytes, _encoding, done) {
  const text = String(bytes).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  if (text.trim()) frame = text;
  done();
} }) as unknown as NodeJS.WriteStream;
stdout.columns = 120; stdout.rows = 36; stdout.isTTY = true;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
async function key(value: string) { stdin.write(value); await tick(); }
async function screen(marker: string) {
  const end = Date.now() + 2500;
  while (!frame.includes(marker) && Date.now() < end) await tick();
  assert.ok(frame.includes(marker), `Expected ${marker}; saw:\n${frame}`);
  await tick();
}
let query = "";
let runs: string[] = [];
let formsOpened = 0;
type Grants = { canWrite?: boolean; canControl?: boolean };
function Harness({ initial, managed = readManaged, canWrite = true, canControl = true }: { initial: string; managed?: () => Promise<PsReply> } & Grants) {
  const [value, setValue] = useState(initial);
  query = value;
  return <CommandPalette active query={value} snapshot={snapshot} canWrite={canWrite} canControl={canControl} width={120}
    readManaged={managed} onChange={setValue} onRun={(line) => runs.push(line)}
    onNewAgent={() => { formsOpened++; }} onCancel={() => {}} />;
}
async function scenario(initial: string, check: () => Promise<void>, managed?: () => Promise<PsReply>, grants: Grants = {}) {
  frame = ""; runs = []; formsOpened = 0;
  const app = render(<Harness initial={initial} managed={managed} {...grants} />,
    { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  try { await screen("Commands"); await check(); }
  finally { app.unmount(); app.cleanup(); }
}

for (const search of ["", "spawn", "new agent"]) {
  await scenario(search, async () => {
    await screen("Spawn agent");
    assert.equal(frame.split("Spawn agent").length - 1, 1,
      "The palette contains one spawn action, apart from the typed search text");
    assert.ok(!frame.includes("spawn an agent from a persona"), "The old spawn shortcut is not a second visible entry");
    await key("\r");
    assert.equal(formsOpened, 1, `${JSON.stringify(search)} opens the spawn form`);
    assert.equal(runs.length, 0, "Selecting spawn opens the form before launching anything");
  });
}
await scenario("spawn", async () => {
  await key("\t");
  assert.equal(formsOpened, 1, "Tab on spawn opens the same form");
});
await scenario("spawn default named_agent", async () => {
  await key("\r");
  assert.deepEqual(runs, ["spawn default named_agent"], "Complete typed spawn commands remain supported");
});
for (const line of ["call @alice", "msg general", "spawn agent"]) {
  await scenario(line, async () => {
    await key("\r");
    assert.deepEqual(runs, [line], `A complete typed command stays literal: ${line}`);
    assert.equal(formsOpened, 0, "A typed persona named agent is not a form search");
  });
}
await scenario("dm", async () => {
  await key("\r");
  await screen("@alice");
  assert.equal(query, "dm ", "Selecting dm opens recipient choices immediately");
  await key("\x1b[B"); await key("\x1b[B"); await key("\r");
  assert.equal(query, "dm @bob ", "Enter selects the highlighted recipient");
  assert.equal(runs.length, 0, "Selecting a recipient does not send an empty DM");
  await screen("Type a message");
  await key("hello @alice"); await key("\r");
  assert.deepEqual(runs, ["dm @bob hello @alice"], "Enter sends the message without replacing its mention");
});
await scenario("attach", async () => {
  await key("\r"); await screen("managed_only");
  assert.ok(!frame.includes("@alice"), "Attach choices come from the manager, including seats absent from presence");
  await key("\r");
  assert.deepEqual(runs, ["attach managed_only"], "Selecting the managed seat attaches to that seat");
});
for (const command of ["status", "call", "msg", "ask", "delchan"]) {
  await scenario(command, async () => {
    await key("\r");
    await screen(command === "status" ? "managed_only" : command === "call" ? "@alice" : command === "ask" ? "@reviewer" : "#general");
    await key("\r");
    if (command === "msg" || command === "ask") {
      assert.equal(runs.length, 0, `${command} waits for message text`);
      await key("hello"); await key("\r");
    }
    assert.equal(runs.length, 1, `${command} runs once after the required selections`);
  });
}
// A managed seat whose presence is working is qualified as `:status` qualifies it: the seat only
// said it was working, and the manager observed no progress.
await scenario("status ", async () => {
  await screen("busy_seat");
  const row = frame.split("\n").find((line) => line.includes("busy_seat")) ?? "";
  assert.ok(row.includes("mesh working · progress unknown") && !/mesh working(?! · progress unknown)/.test(row), `A working managed seat's suggestion says progress unknown; saw: ${row}`);
  assert.ok(frame.split("\n").some((line) => line.includes("managed_only") && line.includes("mesh offline") && !line.includes("progress unknown")), "Every other presence word passes through unqualified");
}, async () => ({ ok: true, silent: [], failed: [], answered: [], rows: [
  { name: "managed_only", id: "managed-id", agent: "opencode", mode: "pty", status: "running", mesh: "offline", uptimeMs: 0 },
  { name: "busy_seat", id: "busy-id", agent: "claude", mode: "pty", status: "running", mesh: "working", uptimeMs: 0 },
] }));
await scenario("attach ", async () => {
  await screen("manager unavailable");
  assert.ok(!frame.includes("@alice"), "A failed manager read is shown without a presence-derived replacement list");
}, async () => ({ ok: false, error: "manager unavailable" }));
await scenario("dm @b", async () => {
  await screen("@bob"); await key("\t");
  assert.equal(query, "dm @bob ", "Existing @ token Tab completion still works");
});
// #4905: Enter on an action this session cannot take used to be swallowed by the palette, so the
// operator saw the row's label and nothing else. The line now reaches the dispatcher, whose refusal
// names the missing permission; the action stays blocked (no picker, no form, no send).
const notices = (line: string, canWrite: boolean, canControl: boolean): string[] => {
  const out: string[] = [];
  runCommand(line, { notify: (msg: string) => out.push(msg) } as unknown as CommandCtx, canWrite, canControl);
  return out;
};
for (const command of ["msg", "dm", "call", "ask"]) {
  await scenario(command, async () => {
    await screen("read-only");
    await key("\r");
    assert.deepEqual(runs, [command], `${command} without publish permission reaches the dispatcher instead of being swallowed`);
    assert.equal(query, command, `${command} opens no picker while read-only`);
    assert.deepEqual(notices(command, false, true), ["read-only - pass --creds to send"], `the dispatcher refuses ${command} with the publish notice`);
  }, undefined, { canWrite: false });
}
await scenario("spawn", async () => {
  await screen("no control path");
  await key("\r");
  assert.deepEqual(runs, ["spawn"], "Spawn without a control path reaches the dispatcher instead of being swallowed");
  assert.equal(formsOpened, 0, "Spawn without a control path opens no form");
  assert.match(notices("spawn", true, false)[0] ?? "", /^no control path - /, "the dispatcher refuses spawn with the control notice, not the publish one");
}, undefined, { canControl: false });
await scenario("msg", async () => {
  await key("\r");
  assert.equal(runs.length, 0, "CONTROL: with publish permission, msg advances to the channel picker rather than running");
  assert.equal(query, "msg ", "CONTROL: the picker opened");
});
console.log("✓ Command selection, recipient/seat/channel/role pickers, message entry, manager failure and blocked-action feedback");
