import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink";
import type { CotalEndpoint, Presence } from "@cotal-ai/core";
import { App } from "../src/console/app.js";
import { NewAgent } from "../src/console/ui/NewAgent.js";
import { launchAgent, type AgentLaunchInput, type AgentLaunchReply } from "../src/console/launch.js";

class Observer extends EventEmitter {
  space = "modal-smoke";
  card = { id: "local.operator", name: "operator", kind: "endpoint", role: "operator" };
  async start() {}
  async stop() {}
  getRoster(): Presence[] { return []; }
  tap() {}
  async listChannels() { return [{ channel: "general", messages: 0 }]; }
  async channelHistory() { return []; }
  async dmHistory() { return []; }
  async readMembership() { return { asOf: undefined, members: [] }; }
  async watchMembership() { return { stop: async () => {} }; }
}

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
stdout.columns = 120;
stdout.rows = 36;
stdout.isTTY = true;
const app = render(<App ep={new Observer() as unknown as CotalEndpoint} canControl canWrite />, {
  stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
async function screen(marker: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!frame.includes(marker) && Date.now() < deadline) await tick();
  assert.ok(frame.includes(marker), `Expected screen to contain ${JSON.stringify(marker)}; saw:\n${frame}`);
  await tick(); // Ink paints before React installs the new screen's input effect.
}
try {
  await screen("roster");
  stdin.write("\x10");
  await screen("Commands");
  assert.ok(frame.includes("Spawn agent"), "Ctrl+P offers the guided spawn form");
  stdin.write("\r");
  await screen("Application");
  for (const label of ["Application", "Persona", "Model", "Name", "Initial request", "Launch agent"]) {
    assert.ok(frame.includes(label), `The launch form contains ${label}`);
  }
  assert.ok(!frame.includes("Help"), "Opening the form does not also activate background shortcuts");
  stdin.write("\x1b");
  await screen("Commands");
  stdin.write("\x1b");
  await screen("roster");
  assert.ok(!frame.includes("Spawn agent"), "Esc closes the modal and restores the console");
  console.log("✓ Ctrl+P → Spawn agent → Esc → console");
} finally {
  app.unmount();
  app.cleanup();
}

// Mount the actual form to exercise the input boundary and submission ownership. The live
// terminal check separately drives this form through the CLI to a real manager and joined seat.
let settle!: (reply: AgentLaunchReply) => void;
const launches: AgentLaunchInput[] = [];
let closed = 0;
frame = "";
const form = render(<NewAgent space="modal-smoke" width={120} height={36}
  applications={["opencode"]} defaultPersona="default" onBack={() => {}}
  onClose={() => { closed++; }} onLaunch={(input) => {
    launches.push(input);
    return new Promise<AgentLaunchReply>((resolve) => { settle = resolve; });
  }} />, { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
async function key(value: string) { stdin.write(value); await tick(); }
try {
  await screen("Application");
  // Escape-coded navigation stays distinct even when Ink reads several events in one chunk.
  // Plain text containing tabs is a paste and must remain text in the current field.
  for (const input of ["opencode", "\x1b[B", "\x1b[B", "opencode/glm-5.3-flash-free", "\x1b[B", "modal_tester", "\x1b[B", "q? explain $HOME without editing files"]) stdin.write(input);
  await tick();
  assert.ok(frame.includes("q? explain $HOME"), "The prompt owns keys that would quit or open console help");
  await key("\t"); await key("\t");
  await key("\r"); await key("\r"); await key("\r");
  assert.equal(launches.length, 1, "Repeated Enter submits exactly one pending launch");
  assert.deepEqual(launches[0], { application: "opencode", persona: "default", model: "opencode/glm-5.3-flash-free",
    name: "modal_tester", prompt: "q? explain $HOME without editing files", events: false },
  "The form carries the exact choices, including literal prompt text and explicit event intent");
  settle({ ok: false, canRetry: false, message: "Outcome unknown: inspect the original request." });
  await screen("Check launch outcome");
  await key("\r");
  assert.equal(launches.length, 1, "An uncertain result cannot be resubmitted");
  assert.equal(closed, 1, "Enter dismisses the uncertain result instead of retrying it");
  console.log("✓ Form input, exact launch choices, single-flight and uncertain result");
} finally { form.unmount(); form.cleanup(); }

// Reach the real child CLI's argument parser, with a known validation refusal before any
// allocation or broker access. The entry override is required by selfArgv's re-exec guard.
const previousEntry = process.argv[1];
const previousSeedSkip = process.env.COTAL_SKIP_CONNECTOR_SEED;
process.argv[1] = fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url));
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";
try {
  const reply = await launchAgent({ space: "unused" }, {
    application: "", persona: "default", model: " ", name: "", events: false,
    prompt: "- review the code; preserve $HOME literally",
  });
  assert.ok(!reply.ok, "The invalid model is refused before allocation");
  assert.equal(reply.message, "--model cannot be empty", "A leading-hyphen prompt reaches CLI validation as literal text");
  assert.equal(reply.canRetry, true, "A pre-allocation refusal can be corrected");
  console.log("✓ Literal launch argv reaches the real CLI without allocating a seat");
} finally {
  process.argv[1] = previousEntry;
  if (previousSeedSkip === undefined) delete process.env.COTAL_SKIP_CONNECTOR_SEED;
  else process.env.COTAL_SKIP_CONNECTOR_SEED = previousSeedSkip;
}
