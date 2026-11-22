import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { readManagerName } from "@cotal-ai/workspace";
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

function launch(target: ReturnType<typeof project>, args: string[]) {
  assertSmokeSandboxDown(target.anchor, args, { cwd: target.root, env });
  const child = spawn(process.execPath, [bin, ...args], { cwd: target.root, env, stdio: ["ignore", "pipe", "pipe"] });
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

async function cli(target: ReturnType<typeof project>, ...args: string[]) {
  const run = launch(target, args);
  try {
    await waitForOwnedChild(() => run.state.closed, 120_000, args.join(" "));
    assert.ifError(run.state.error);
    assert.equal(run.state.signal, null);
    return run.output();
  } finally { await run.close(); }
}

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
  } finally { await stop(target); }
}

const controller = project("controller");
const prepared = await cli(controller, "space", "create", controller.space);
assert.equal(prepared.code, 0, prepared.out + prepared.err);
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
await occupied(controller, port, undefined);
await foreground(controller, server, "manager");
await foreground(controller, server, "KeptManager", "KeptManager");
await occupied(controller, port, "KeptManager");
await foreground(controller, server, "KeptManager");
await retainedLauncher();
finish();
