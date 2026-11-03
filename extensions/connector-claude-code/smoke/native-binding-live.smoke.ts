/** Exercise the installed command-hook process and its native lifecycle socket without classic.*. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cotal-native-binding-live-"));
const original = process.env.TMPDIR;
process.env.TMPDIR = root;
const { openWakeFeed } = await import("../src/wake-feed.js");
const { bindPersonalSession, readPersonalBinding } = await import("../src/native-binding.js");
const feed = await openWakeFeed(process.pid);
const events: Record<string, unknown>[] = [];
feed.onNative(async (event) => { events.push(event); });
const a = randomUUID(), b = randomUUID();
const event = (session: string, hook_event_name: string) => ({
  hook_event_name, session_id: session, transcript_path: join(root, `${session}.jsonl`),
  prompt: "PRIVATE_PROMPT", tool_input: { secret: "PRIVATE_INPUT" }, tool_response: "PRIVATE_RESPONSE",
});
const hook = (value: unknown) => new Promise<void>((resolveHook, reject) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "CLAUDE_PLUGIN_DATA"));
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "../dist/hook.cjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (piece: Buffer) => { stdout += piece.toString(); });
  child.stderr.on("data", (piece: Buffer) => { stderr += piece.toString(); });
  child.on("error", reject);
  child.on("close", (code) => {
    try { assert.equal(code, 0); assert.equal(stdout, ""); assert.equal(stderr, ""); resolveHook(); }
    catch (error) { reject(error); }
  });
  child.stdin.end(JSON.stringify(value));
});
try {
  await hook(event(a, "SessionStart"));
  await hook(event(b, "SessionStart"));
  const state = join(root, `cotal-claude-native-${process.getuid?.() ?? "local"}`);
  assert.equal(readPersonalBinding(a).session_id, a);
  assert.equal(readPersonalBinding(b).session_id, b);
  assert.equal(lstatSync(join(state, `${a}.json`)).mode & 0o077, 0);
  assert(!readFileSync(join(state, `${a}.json`), "utf8").includes("PRIVATE_"));
  console.log("  ✓ real command hooks capture separate private session metadata without prompt/tool content");
  await bindPersonalSession(readPersonalBinding(a), process.pid);
  await hook(event(a, "UserPromptSubmit"));
  await hook(event(a, "PreToolUse"));
  await hook(event(a, "Notification"));
  await hook(event(a, "Stop"));
  await hook(event(a, "StopFailure"));
  assert.deepEqual(events.map((row) => row.hook_event_name), ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "StopFailure"]);
  assert(events.every((row) => row.session_id === a));
  assert(!JSON.stringify(events).includes("PRIVATE_"));
  console.log("  ✓ the actual command-hook executable forwards lifecycle to the explicitly bound native host");
  await hook(event(b, "Stop"));
  await hook({ ...event(a, "Stop"), agent_id: "child" });
  await hook({ ...event(a, "Stop"), transcript_path: join(root, "wrong.jsonl") });
  assert.equal(events.length, 6);
  assert.equal(readPersonalBinding(a).hook_event_name, "StopFailure");
  console.log("  ✓ an unbound sibling, a subagent and a mismatched transcript cannot drive the connection");
  await hook(event(a, "SessionEnd"));
  assert.equal(events.at(-1)?.hook_event_name, "SessionEnd");
  assert(!existsSync(join(state, `${a}.json`)) && !existsSync(join(state, `${a}.json.host`)));
  assert.equal(readPersonalBinding(b).session_id, b);
  console.log("  ✓ native session end clears only its metadata after confirmed lifecycle handoff");
} finally {
  feed.close();
  if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
  rmSync(root, { recursive: true, force: true });
}
console.log("NATIVE BINDING LIVE TESTS PASSED");
