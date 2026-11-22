import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { canonicalLocalProcessPath, LIVE_MANAGER_NAME_RECORD, MANAGER_NAME_RECORD, MANAGER_SPARE_CAPABILITY, readManagerName, recordManagerName } from "@cotal-ai/workspace";
import { finishOwnedChild, observeOwnedChild, waitForOwnedChild } from "./_foreground-owned-child.js";

const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
assert.ok(existsSync(bin), "build cotal-ai before running this smoke");
const scratch = mkdtempSync(join(tmpdir(), "cotal-up-manager-name-"));
console.log(`Sandbox retained: ${scratch}`);
const home = join(scratch, "home");
const env = {
  PATH: process.env.PATH, HOME: home, USERPROFILE: home,
  SystemRoot: process.env.SystemRoot, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "config"),
  XDG_RUNTIME_DIR: join(home, "runtime"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
const { check, finish } = createSuite();
let logNumber = 0;

function project(space: string) {
  const root = join(scratch, space);
  return { root, space, anchor: recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME }) };
}

function launch(target: ReturnType<typeof project>, args: string[], preload?: string) {
  assertSmokeSandboxDown(target.anchor, args, { cwd: target.root, env });
  const child = spawn(process.execPath, [...(preload ? ["--require", preload] : []), bin, ...args], { cwd: target.root, env, stdio: ["ignore", "pipe", "pipe"] });
  const state = observeOwnedChild(child);
  let out = "", err = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  const label = `${target.space}: ${args.join(" ")}`;
  const log = join(scratch, `${++logNumber}-${args[0]}.json`);
  return {
    state,
    output: () => ({ code: state.code, out, err }),
    async close() {
      try { await finishOwnedChild(child, state, () => {}, () => [], label); }
      finally { writeFileSync(log, JSON.stringify({ label, ...state, out, err }), { mode: 0o600 }); }
    },
  };
}

async function runCli(target: ReturnType<typeof project>, args: string[], preload?: string) {
  const run = launch(target, args, preload);
  try {
    await waitForOwnedChild(() => run.state.closed, 120_000, args.join(" "));
    assert.ifError(run.state.error);
    assert.equal(run.state.signal, null);
    return run.output();
  } finally { await run.close(); }
}
const cli = (target: ReturnType<typeof project>, ...args: string[]) => runCli(target, args);

async function occupied(target: ReturnType<typeof project>, port: number, expected: string | undefined) {
  const listener = createServer((socket) => socket.end());
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", resolve);
    });
    const refused = await cli(target, "up", "--foreground", "--server", `nats://127.0.0.1:${port}`, "--manager-name", "RefusedOverride");
    assert.equal(refused.code, 2, refused.out + refused.err);
    assert.match(refused.err, /CONFLICT/);
    assert.match(refused.err, /the controller stack started no member.*no broker was launched/s);
    const saved = readManagerName(target);
    check(expected === undefined ? "a busy port leaves no manager name" : "a busy port keeps the saved manager name", saved === expected, { saved, expected });
  } finally {
    if (listener.listening) await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
}

async function checkLiveName(target: ReturnType<typeof project>, expected: string) {
  const who = await cli(target, "who", "--all", "--json");
  assert.equal(who.code, 0, who.out + who.err);
  const envelope = JSON.parse(who.out) as { result: { items: { role: string; name: string; status: string }[] } };
  const names = envelope.result.items.filter((row) => row.role === "manager" && row.status !== "offline").map((row) => row.name);
  check(`${target.space} serves as ${expected}`, names.length === 1 && names[0] === expected, names);
}

async function stop(target: ReturnType<typeof project>) {
  const down = await cli(target, "down", "--yes");
  assert.equal(down.code, 0, down.out + down.err);
}

async function preparedProject(space: string) {
  const target = project(space);
  const prepared = await cli(target, "space", "create", target.space);
  assert.equal(prepared.code, 0, prepared.out + prepared.err);
  return target;
}

async function foreground(target: ReturnType<typeof project>, server: string, expected: string, name?: string) {
  const run = launch(target, ["up", "--foreground", "--server", server, ...(name !== undefined ? ["--manager-name", name] : [])]);
  try {
    const started = () => run.output().out.includes("Controller stack started");
    await waitForOwnedChild(() => started() || run.state.exited || !!run.state.error, 120_000, "controller stack ready");
    assert.ok(started() && !run.state.exited, run.output().out + run.output().err);
    await checkLiveName(target, expected);
    if (name !== undefined) {
      const saved = readManagerName(target);
      check("a serving manager records the requested name", saved === name, saved);
      const rename = await cli(target, "up", "--server", server, "--manager-name", "LiveOverride");
      assert.equal(rename.code, 2, rename.out + rename.err);
      assert.match(rename.err, /keeps the name it started with/);
      check("a running manager keeps its saved name", readManagerName(target) === name);
    }
  } finally {
    try {
      await stop(target);
      await waitForOwnedChild(() => run.state.closed, 10_000, "foreground up exits after down");
      assert.equal(run.state.code, 0, run.output().err);
    } finally { await run.close(); }
  }
}

async function retainedLauncher() {
  const target = project("retained");
  const server = `nats://127.0.0.1:${await freePort()}`;
  const name = "--Retained Manager";
  const args = ["up", "--open", "--server", server, `--manager-name=${name}`];
  const refused = await cli(target, ...args, "--json");
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.match(refused.out, /retained native launcher/);
  const afterRefusal = readManagerName(target);
  check("a retained-launcher refusal leaves no manager name", afterRefusal === undefined, afterRefusal);
  try {
    const started = await cli(target, ...args);
    assert.equal(started.code, 0, started.out + started.err);
    await checkLiveName(target, name);
    const saved = readManagerName(target);
    check("a retained-launcher manager records the requested name", saved === name, saved);
    const same = await cli(target, ...args);
    check("the retained launcher accepts a refresh naming the live manager", same.code === 0, same);
    const different = await cli(target, "up", "--open", "--server", server, "--manager-name", "Different");
    check("the retained launcher refuses a refresh naming a different manager", different.code === 2 && /keeps the name it started with/.test(different.err), different);
  } finally { await stop(target); }
}

async function checkUnverifiedName(target: ReturnType<typeof project>, args: string[]) {
  const liveRecord = canonicalLocalProcessPath(LIVE_MANAGER_NAME_RECORD, target);
  const held = `${liveRecord}.held`;
  const originally = JSON.parse(readFileSync(liveRecord, "utf8")) as { pid: number; token: string; name: string; version: number };
  renameSync(liveRecord, held);
  try {
    const missing = await cli(target, ...args, "--manager-name", "NotSaved");
    check("a named refresh refuses without live-name evidence", missing.code === 2 && /its live name cannot be confirmed/.test(missing.out), missing);
    writeFileSync(liveRecord, JSON.stringify({ ...originally, token: `${originally.token}0` }), { mode: 0o600 });
    const stale = await cli(target, ...args, "--manager-name", "NotSaved");
    check("a live-name record with a stale creation token does not authorize reuse", stale.code === 2 && /its live name cannot be confirmed/.test(stale.out), stale);
    const unnamed = await cli(target, ...args);
    check("an unnamed refresh does not require live-name evidence", unnamed.code === 0 && JSON.parse(unnamed.out).outcome === "no-op", unnamed);
  } finally { renameSync(held, liveRecord); }
}

async function nameWriteFailures() {
  const target = await preparedProject("name-write");
  const server = `nats://127.0.0.1:${await freePort()}`;
  const capability = canonicalLocalProcessPath(MANAGER_SPARE_CAPABILITY, target);
  const record = canonicalLocalProcessPath(MANAGER_NAME_RECORD, target);
  const args = ["up", "--open", "--server", server, "--json"];
  try {
    mkdirSync(capability, { mode: 0o700 });
    try {
      const failed = await cli(target, ...args, "--manager-name", "NotReady");
      assert.equal(failed.code, 4, failed.out + failed.err);
      assert.match(failed.out, /OPERATION_PARTIAL/);
      assert.ok(failed.out.includes(capability));
      check("a manager that fails to publish its spare capability leaves no saved name", readManagerName(target) === undefined);
    } finally { rmdirSync(capability); }

    recordManagerName(target, "PreviouslySaved");
    const preload = join(scratch, "name-write-fault.cjs");
    writeFileSync(preload, `const fs = require("node:fs");
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (to === ${JSON.stringify(record)}) throw Object.assign(new Error("name record is read-only"), { code: "EROFS" });
  return rename(from, to);
};
require("node:module").syncBuiltinESMExports();\n`, { mode: 0o600 });
    const started = await runCli(target, [...args, "--manager-name", "NotSaved"], preload);
    assert.equal(started.code, 4, started.out + started.err);
    const receipt = JSON.parse(started.out) as { outcome: string; warnings: { code: string; message: string }[]; result: { members: { role: string; process?: { pid: number; token: string } }[] } };
    check("the partial startup receipt names the failed save", receipt.outcome === "partial" && receipt.warnings.some((warning) =>
      warning.code === "MANAGER_NAME_NOT_RECORDED" && warning.message.includes("NotSaved") && warning.message.includes("name record is read-only")), receipt.warnings);
    await checkLiveName(target, "NotSaved");
    check("a reported name write failure keeps the previous name", readManagerName(target) === "PreviouslySaved");

    const wrongName = await cli(target, ...args, "--manager-name", "PreviouslySaved");
    check("refresh with the saved name refuses when the live name differs", wrongName.code === 2 && /LIFECYCLE_BLOCKED/.test(wrongName.out), wrongName);
    const liveName = await cli(target, ...args, "--manager-name", "NotSaved");
    const refreshed = JSON.parse(liveName.out) as typeof receipt;
    const before = receipt.result.members.find((row) => row.role === "manager")?.process;
    const after = refreshed.result?.members.find((row) => row.role === "manager")?.process;
    check("refresh with the live name reuses the exact manager", liveName.code === 0 && refreshed.outcome === "no-op" && before !== undefined && before.pid === after?.pid && before.token === after?.token, liveName);
    await checkUnverifiedName(target, args);
    await checkLiveName(target, "NotSaved");
    check("neither refresh writes a name", readManagerName(target) === "PreviouslySaved");
  } finally { await stop(target); }
}

function listenerIsUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1");
    const done = (up: boolean) => { socket.destroy(); resolve(up); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

async function adoptedListener() {
  const target = project("adopted-name");
  const port = await freePort();
  const journalPath = join(target.root, ".cotal", "maintenance", "v1", "journal.json");
  const readBoundAttempt = () => JSON.parse(readFileSync(journalPath, "utf8")) as { state: string; listenerProof?: { processOwner: { pid: number } } };
  try {
    const first = await cli(target, "up", "--open", "--server", `nats://127.0.0.1:${port}`, "--manager-name", "BeforeResume");
    assert.equal(first.code, 0, first.out + first.err);
    const cut = await cli(target, "down", "--preserve-state");
    assert.equal(cut.code, 0, cut.out + cut.err);

    const preload = join(scratch, "interrupt-bound-resume.cjs");
    writeFileSync(preload, `const fs = require("node:fs");
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const result = rename(from, to);
  if (to === ${JSON.stringify(journalPath)}) {
    const journal = JSON.parse(fs.readFileSync(to, "utf8"));
    if (journal.state === "resume-intent" && journal.listenerProof) process.exit(86);
  }
  return result;
};
require("node:module").syncBuiltinESMExports();\n`, { mode: 0o600 });
    const interrupted = await runCli(target, ["up", "--detach"], preload);
    assert.equal(interrupted.code, 86, interrupted.out + interrupted.err);
    const journal = readBoundAttempt();
    assert.equal(journal.state, "resume-intent");
    const pid = journal.listenerProof?.processOwner.pid;
    assert.ok(pid && process.kill(pid, 0), "the interrupted resume left its bound broker alive");
    for (let i = 0; i < 100 && !await listenerIsUp(port); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(await listenerIsUp(port), "the bound broker is accepting connections");
    const resumed = await cli(target, "up", "--detach", "--manager-name", "AfterResume");
    assert.equal(resumed.code, 0, resumed.out + resumed.err);
    check("resume adopted the bound broker and consumed its journal", !existsSync(journalPath) && Number(readFileSync(join(target.root, ".cotal", "nats.pid"), "utf8")) === pid);
    await checkLiveName(target, "AfterResume");
    check("the adopted-listener resume saves the requested name", readManagerName(target) === "AfterResume");
  } finally { await stop(target); }
}

const controller = await preparedProject("controller");
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
await occupied(controller, port, undefined);
await foreground(controller, server, "manager");
await foreground(controller, server, "KeptManager", "KeptManager");
await occupied(controller, port, "KeptManager");
await foreground(controller, server, "KeptManager");
await retainedLauncher();
await nameWriteFailures();
await adoptedListener();
finish();
