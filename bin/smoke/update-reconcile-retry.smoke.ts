import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { inspectLock, processGroupMembers, SEEDED_EXTENSIONS } from "@cotal-ai/workspace";
import { observeOwnedChild, waitForOwnedChild } from "../../implementations/cli/smoke/_foreground-owned-child.js";

if (process.platform !== "linux") {
  console.log("SKIP update-reconcile-retry: requires the Linux updater and process group");
  process.exit(0);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "update-retry-")));
const bin = dirname(import.meta.dirname);
const modules = join(root, "prefix/lib/node_modules");
const installed = join(modules, "cotal-ai");
const entry = join(installed, "dist/cotal.js");
const marker = join(modules, ".cotal-update-child");
const recovery = join(root, "state/update-recovery.json");
const project = join(root, "project");
const version = JSON.parse(readFileSync(join(bin, "package.json"), "utf8")).version as string;
const native = join(root, "native");
const env: NodeJS.ProcessEnv = {
  HOME: join(root, "home"), COTAL_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: join(root, "rt"), TMPDIR: root, PATH: `${native}:${process.env.PATH}`,
  COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", RETRY_TEST_ROOT: root, RETRY_TEST_VERSION: version,
};
for (const path of [project, env.HOME!, env.COTAL_HOME!, env.XDG_RUNTIME_DIR!, native, join(root, "prefix/bin")]) mkdirSync(path, { recursive: true, mode: 0o700 });
for (const name of ["systemctl", "loginctl", "busctl", "launchctl", "schtasks"]) writeFileSync(join(native, name), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
cpSync(join(bin, "dist"), join(installed, "dist"), { recursive: true });
cpSync(join(bin, "package.json"), join(installed, "package.json"));
symlinkSync(join(bin, "node_modules"), join(installed, "node_modules"));
symlinkSync(entry, join(root, "prefix/bin/cotal"));

// Reproduce an already-current prefix with the built-ins accounted for but removed by the user.
const seed = join(env.XDG_CONFIG_HOME!, "cotal/seed");
mkdirSync(seed, { recursive: true, mode: 0o700 });
for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: Object.keys(SEEDED_EXTENSIONS) }));
writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));

const writer = join(root, "writer");
const packument = JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } });
const pending = new Set<ServerResponse>();
let gateRegistry = false;
const registry = createServer((_req, res) => {
  if (!gateRegistry || existsSync(writer)) res.end(packument);
  else { pending.add(res); res.on("close", () => pending.delete(res)); }
});
await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
env.npm_config_registry = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;

const sandbox = recordSmokeSandbox({ root: project, cotalHome: env.COTAL_HOME!, xdgConfigHome: env.XDG_CONFIG_HOME! });
const jobs: ReturnType<typeof launch>[] = [];
function launch(name: string, args: string[], cwd = project) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const state = observeOwnedChild(child);
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>(resolve => child.once("close", (code, signal) => {
    writeFileSync(join(root, `${name}.log`), output);
    resolve({ code, signal, output });
  }));
  return { child, state, done, get output() { return output; } };
}
async function cli(name: string, ...args: string[]) {
  assertSmokeSandboxDown(sandbox, args, { cwd: project, env });
  const job = launch(name, [entry, ...args]);
  jobs.push(job);
  await waitForOwnedChild(() => job.state.closed, 30_000, `${name}: ${job.output}`);
  return job.done;
}
const space = "update-retry";
const server = `nats://127.0.0.1:${await freePort()}`;
let up: ReturnType<typeof launch> | undefined;
let parent: ReturnType<typeof launch> | undefined;
let writerPid: number | undefined;
console.log(`update-reconcile-retry evidence: ${root}`);
try {
  const create = await cli("space-create", "space", "create", space);
  assert.equal(create.code, 0, create.output);
  up = launch("up", [entry, "up", "--foreground", "--open", "--no-manager", "--space", space, "--server", server]);
  await waitForOwnedChild(() => up!.output.includes("nats://") && up!.output.includes("running"), 30_000, "foreground space ready");
  const control = await cli("control-update", "update", "--self");
  assert.equal(control.code, 0, control.output);
  assert.match(control.output, /installed package closure is current/);
  const controlStatus = await cli("control-status", "status");
  assert.equal(controlStatus.code, 0, controlStatus.output);
  console.log("Control: current self-update and immediate status both exited 0.");

  parent = launch("parent", ["--import", "tsx", join(import.meta.dirname, "update-reconcile-retry.fixture.ts")], dirname(bin));
  await waitForOwnedChild(() => existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).phase === "live", 15_000, "live global reconcile marker");
  writerPid = JSON.parse(readFileSync(marker, "utf8")).pid as number;
  assert.ok(parent.child.kill("SIGKILL"));
  assert.equal((await parent.done).signal, "SIGKILL");
  gateRegistry = true;
  const retry = launch("retry", [entry, "update", "--self"]);
  jobs.push(retry);
  await waitForOwnedChild(() => existsSync(writer), 30_000, "orphan acquired the installation writer");
  for (const response of pending) response.end(packument);
  await waitForOwnedChild(() => {
    const lock = inspectLock(join(modules, ".cotal-update.lock"));
    return retry.state.closed || lock.state === "active" && lock.owner.pid === retry.child.pid;
  }, 30_000, "retry either waits for the orphan or exits early");
  const statusDuring = await cli("status-during", "status");
  assert.equal(statusDuring.code, 4, statusDuring.output);
  assert.match(statusDuring.output, new RegExp(`pid ${writerPid}.*is changing this installation`));
  const who = await cli("who-during", "who");
  assert.equal(who.code, 0, who.output);
  assert.equal(retry.state.exited, false, `retry exited ${retry.state.code} while status exited 4 naming the orphan and who exited 0:\n${retry.output}`);

  writeFileSync(join(root, "release"), "");
  await waitForOwnedChild(() => retry.state.closed, 30_000, "retry completed after orphan release");
  const result = await retry.done;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Retained unusable interrupted-update records/);
  assert.match(result.output, /installed package closure is current/);
  const after = await cli("status-after", "status");
  assert.equal(after.code, 0, after.output);
  for (const path of [marker, recovery, join(env.COTAL_HOME!, ".update-closure.lock"), join(modules, ".cotal-update.lock")]) {
    assert.equal(existsSync(path), false, `leftover update state: ${path}`);
  }
  console.log("Retry waited for the orphan, then verified the closure. Immediate status exited 0.");
  emitSentinel({ passed: 2, failed: 0 });
} finally {
  writeFileSync(join(root, "release"), "");
  gateRegistry = false;
  for (const response of pending) response.end(packument);
  if (parent && !parent.state.exited) parent.child.kill("SIGKILL");
  if (parent) await parent.done;
  if (!writerPid && existsSync(marker)) {
    const record = JSON.parse(readFileSync(marker, "utf8"));
    if (record.owner === parent?.child.pid && record.phase === "live") writerPid = record.pid;
  }
  for (const job of jobs) {
    if (!job.state.exited) job.child.kill("SIGTERM");
    await job.done;
  }
  if (up) {
    if (!up.state.exited) up.child.kill("SIGTERM");
    await up.done;
  }
  await new Promise<void>(resolve => registry.close(() => resolve()));
  if (writerPid) await waitForOwnedChild(() => processGroupMembers(writerPid!).length === 0, 10_000, "owned reconcile group exited");
}
