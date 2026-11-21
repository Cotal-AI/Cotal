import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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
const fixture = join(import.meta.dirname, "update-reconcile-retry.fixture.ts");
const updateLock = join(modules, ".cotal-update.lock");
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
  if (!gateRegistry) res.end(packument);
  else { pending.add(res); res.on("close", () => pending.delete(res)); }
});
function releaseRegistry(): void {
  gateRegistry = false;
  for (const response of pending) response.end(packument);
  pending.clear();
}
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
async function finishUpdate(job: ReturnType<typeof launch>, label: string) {
  await waitForOwnedChild(() => job.state.closed, 30_000, label);
  const result = await job.done;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /installed package closure is current/);
  const after = await cli(`${label}-status`, "status");
  assert.equal(after.code, 0, after.output);
  for (const path of [marker, recovery, join(env.COTAL_HOME!, ".update-closure.lock"), updateLock]) {
    assert.equal(existsSync(path), false, `leftover update state: ${path}`);
  }
  return result;
}

async function checkLateWriter(): Promise<void> {
  gateRegistry = true;
  const retry = launch("late-retry", [entry, "update", "--self"]);
  jobs.push(retry);
  await waitForOwnedChild(() => pending.size > 0, 15_000, "retry has reached npm before any writer starts");
  const owner = launch("late-owner", ["--import", "tsx", fixture, "late-writer"], dirname(bin));
  jobs.push(owner);
  await waitForOwnedChild(() => existsSync(join(root, "late-writer")), 15_000, "late writer has acquired both locks");
  releaseRegistry();
  await waitForOwnedChild(() => retry.state.exited || retry.output.includes("Waiting for another updater"), 15_000, "retry observed the late writer");
  const status = await cli("late-status-during", "status");
  assert.equal(status.code, 4, status.output);
  assert.match(status.output, new RegExp(`pid ${owner.child.pid}.*is changing this installation`));
  assert.equal(retry.state.exited, false, retry.output);
  assert.doesNotMatch(retry.output, /installed package closure is current/);
  writeFileSync(join(root, "late-release"), "");
  await waitForOwnedChild(() => owner.state.closed, 15_000, "late writer has released both locks");
  assert.equal((await owner.done).code, 0);
  await finishUpdate(retry, "late-after");
  console.log("Late writer: the retry waited after the registry lookup and immediate status exited 0 after release.");
}

async function checkClosureContention(): Promise<void> {
  gateRegistry = true;
  const retry = launch("closure-retry", [entry, "update", "--self"]);
  jobs.push(retry);
  await waitForOwnedChild(() => pending.size > 0, 15_000, "retry waiting for npm before closure contention");
  const owner = launch("closure-owner", ["--import", "tsx", fixture, "closure-only"], dirname(bin));
  jobs.push(owner);
  await waitForOwnedChild(() => existsSync(join(root, "closure-only")), 15_000, "closure writer acquired its lock");
  releaseRegistry();
  await waitForOwnedChild(() => retry.state.closed, 15_000, "retry refuses without blocking on the closure writer");
  const result = await retry.done;
  assert.equal(result.code, 3, result.output);
  assert.match(result.output, new RegExp(`a closure writer.*pid ${owner.child.pid}.*retry once it finishes`));
  assert.doesNotMatch(result.output, /remove .*\.update-closure\.lock/);
  assert.doesNotMatch(result.output, /installed package closure is current/);
  assert.equal(existsSync(updateLock), false);
  writeFileSync(join(root, "closure-release"), "");
  await waitForOwnedChild(() => owner.state.closed, 15_000, "closure writer released its lock");
  assert.equal((await owner.done).code, 0);
  console.log("Closure-only writer: the retry refused promptly and released the npm reservation.");
}

async function checkUnreadableMarker(): Promise<void> {
  for (const name of ["dangling", "linked", "malformed"] as const) {
    const target = join(root, `${name}-target`);
    if (name === "linked") writeFileSync(target, "unchanged\n");
    if (name === "malformed") writeFileSync(marker, "{}\n");
    else symlinkSync(target, marker);
    const result = await cli(name, "update", "--self");
    assert.equal(result.code, 3, result.output);
    assert.match(result.output, /process mutation marker is (?:not a regular file|invalid)/);
    assert.doesNotMatch(result.output, /installed package closure is current|Waiting for another updater/);
    assert.equal(existsSync(updateLock), false);
    assert.equal(name === "malformed" ? readFileSync(marker, "utf8") : readlinkSync(marker), name === "malformed" ? "{}\n" : target);
    if (name === "linked") assert.equal(readFileSync(target, "utf8"), "unchanged\n");
    renameSync(marker, join(root, `${name}-marker`));
  }
  console.log("Unreadable custody: dangling and live symlinks and invalid records each refused once, preserving evidence.");
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

  parent = launch("parent", ["--import", "tsx", fixture], dirname(bin));
  await waitForOwnedChild(() => existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).phase === "live", 15_000, "live global reconcile marker");
  writerPid = JSON.parse(readFileSync(marker, "utf8")).pid as number;
  assert.ok(parent.child.kill("SIGKILL"));
  assert.equal((await parent.done).signal, "SIGKILL");
  gateRegistry = true;
  const retry = launch("retry", [entry, "update", "--self"]);
  jobs.push(retry);
  await waitForOwnedChild(() => existsSync(writer), 30_000, "orphan acquired the installation writer");
  releaseRegistry();
  await waitForOwnedChild(() => {
    const lock = inspectLock(updateLock);
    return retry.state.closed || lock.state === "active" && lock.owner.pid === retry.child.pid;
  }, 30_000, "retry either waits for the orphan or exits early");
  const statusDuring = await cli("status-during", "status");
  assert.equal(statusDuring.code, 4, statusDuring.output);
  assert.match(statusDuring.output, new RegExp(`pid ${writerPid}.*is changing this installation`));
  const who = await cli("who-during", "who");
  assert.equal(who.code, 0, who.output);
  assert.equal(retry.state.exited, false, `retry exited ${retry.state.code} while status exited 4 naming the orphan and who exited 0:\n${retry.output}`);

  writeFileSync(join(root, "release"), "");
  const result = await finishUpdate(retry, "orphan-after");
  assert.match(result.output, /Retained unusable interrupted-update records/);
  console.log("Retry waited for the orphan, then verified the closure. Immediate status exited 0.");
  await checkLateWriter();
  await checkClosureContention();
  await checkUnreadableMarker();
  emitSentinel({ passed: 7, failed: 0 });
} finally {
  writeFileSync(join(root, "release"), "");
  writeFileSync(join(root, "late-release"), "");
  writeFileSync(join(root, "closure-release"), "");
  releaseRegistry();
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
