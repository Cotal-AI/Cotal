/** A real controller broker crash must end foreground up with failure so an OS-owned
 * restart can repair its recorded store. Uses shipped CLI entries and private state only.
 * The harness models the next OS invocation, not systemd or launchd itself. No native unit
 * is installed or controlled. Logs and sandbox state are retained.
 * Run: pnpm smoke:foreground-broker-crash:live */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { assertRecordIdentity, identityRecord, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { observeOwnedChild, waitForOwnedChild } from "./_foreground-owned-child.js";

const tree = resolve(import.meta.dirname, "../../..");
const entry = join(tree, "bin/cotal.ts"), loader = import.meta.resolve("tsx");
const base = mkdtempSync(join(tmpdir(), "cotal-foreground-broker-crash-"));
const root = join(base, "project"), home = join(base, "home");
for (const dir of [root, home, join(base, "config"), join(base, "runtime")]) mkdirSync(dir, { mode: 0o700 });
const env = {
  PATH: process.env.PATH ?? "",
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COTAL_|JCODE_|CLAUDE_|ANTHROPIC_|OPENAI_|INVOCATION_ID)/.test(key))),
  HOME: home, COTAL_HOME: join(base, "machine"), XDG_CONFIG_HOME: join(base, "config"), XDG_RUNTIME_DIR: join(base, "runtime"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
// Any accidental native service access fails inside the sandbox rather than touching the host.
const native = join(base, "native");
mkdirSync(native, { mode: 0o700 });
for (const tool of ["systemctl", "loginctl", "launchctl", "schtasks"]) writeFileSync(join(native, tool), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
env.PATH = `${native}:${process.env.PATH}`;
const sandbox = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
const space = "foreground-broker-crash", port = await freePort();
const server = `nats://127.0.0.1:${port}`;
let transcript = "";
function cli(...args: string[]) {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  const result = spawnSync(process.execPath, ["--import", loader, entry, ...args], options);
  transcript += `\n${args.join(" ")}\nexit=${result.status} signal=${result.signal}\n${result.stdout}${result.stderr}`;
  writeFileSync(join(base, "commands.log"), transcript);
  assert.ifError(result.error);
  return result;
}
interface Instance { definition: string; instanceId: string; observedProcess: string; pid: number | null }
function status() {
  const result = cli("status", "--space", space, "--json");
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { result: { services: { instances: Instance[] }; meshes: { items: { space: string; server: string }[] } } };
}
function broker(): ProcessIdentityRecord {
  const row = status().result.services.instances.find((item) => item.definition === "stack-broker" && item.observedProcess === "running");
  assert.ok(row?.pid, "the public status reports this stack's running broker");
  const pin = identityRecord(row.pid);
  assert.ok("token" in pin, "the owned broker has a process creation pin");
  return pin;
}
const runs: { child: ChildProcess; state: ReturnType<typeof observeOwnedChild>; io: { out: string; err: string } }[] = [];
function foreground(...args: string[]) {
  const child = spawn(process.execPath, ["--import", loader, entry, "up", "--foreground", "--space", space, "--no-manager", ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const io = { out: "", err: "" };
  child.stdout.on("data", (data: Buffer) => { io.out += data; });
  child.stderr.on("data", (data: Buffer) => { io.err += data; });
  const run = { child, state: observeOwnedChild(child), io };
  runs.push(run);
  return run;
}
async function ready(run: ReturnType<typeof foreground>, heading: string) {
  const end = Date.now() + 120_000;
  while (!run.io.out.includes(heading) && Date.now() < end) {
    assert.ifError(run.state.error);
    assert.equal(run.state.exited, false, run.io.err);
    await delay(50);
  }
  assert.ok(run.io.out.includes(heading), `${heading}: ${run.io.out}${run.io.err}`);
  // The startup receipt precedes entering the lifetime hold, so give its first poll a turn too.
  await delay(1200);
  assert.equal(run.state.exited, false, "positive control: healthy foreground owner stays running");
}
let checks = 0;
console.log(`foreground-broker-crash evidence: ${base}`);
try {
  assert.equal(cli("space", "create", space).status, 0); checks++;
  assert.equal(cli("up", "--space", space, "--server", server, "--detach", "--no-manager").status, 0); checks++;
  const first = broker();
  const holder = foreground();
  await ready(holder, "Controller stack already running");
  assert.deepEqual(broker(), first, "positive control: takeover keeps the healthy broker"); checks++;
  assert.equal(assertRecordIdentity(first).kind, "match");
  process.kill(first.pid, "SIGKILL");
  await waitForOwnedChild(() => holder.state.closed, 15_000, "foreground owner reports broker death");
  assert.equal(holder.state.code, 1, holder.io.err); checks++;
  assert.match(holder.io.err, /Foreground stack failed:.*broker/); checks++;
  assert.equal(existsSync(join(root, ".cotal", "stack-foreground.hold")), false); checks++;
  assert.ok(status().result.meshes.items.some((item) => item.space === space && item.server === server), "the failed stack remains registered for repair"); checks++;
  const journalPath = join(root, ".cotal", "stack-controller.json");
  const before = JSON.parse(readFileSync(journalPath, "utf8")) as { broker: unknown };
  // The next supervisor invocation is the same public foreground entry, without down or setup.
  const repair = foreground();
  await ready(repair, "Controller stack started");
  assert.notEqual(broker().pid, first.pid, "the foreground restart replaces the killed broker"); checks++;
  const after = JSON.parse(readFileSync(journalPath, "utf8")) as { broker: unknown };
  assert.deepEqual(after.broker, before.broker, "repair reuses the recorded broker store and configuration"); checks++;
  // An intentional whole-stack stop is success, never a request to restart it.
  assert.equal(cli("down", "--space", space, "--yes").status, 0); checks++;
  await waitForOwnedChild(() => repair.state.closed, 15_000, "intentional down releases the owner");
  assert.equal(repair.state.code, 0, repair.io.err); checks++;
  assert.doesNotMatch(repair.io.err, /Foreground stack failed/); checks++;
} finally {
  for (const [index, run] of runs.entries()) {
    if (!run.state.exited && !run.state.error) {
      run.child.kill("SIGTERM");
      await waitForOwnedChild(() => run.state.closed, 120_000, "owned foreground cleanup");
    }
    writeFileSync(join(base, `foreground-${index}.log`), run.io.out + run.io.err);
  }
  assert.equal(cli("down", "--space", space, "--yes").status, 0, "private stack cleanup completes");
}
console.log(`foreground-broker-crash: ${checks} passed, 0 failed`);
emitSentinel({ cells: checks, passed: checks, failed: 0 });
