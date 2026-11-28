import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

assert.equal(process.pid, 1, "the fixture must own its disposable PID namespace");
const disk = process.argv[2];
const home = join(disk, "home");
Object.assign(process.env, {
  HOME: home, COTAL_HOME: home, TMPDIR: join(disk, "tmp"),
  XDG_RUNTIME_DIR: join(disk, "run"), XDG_CONFIG_HOME: join(disk, "config"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1",
});
for (const key of ["TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME"]) mkdirSync(process.env[key], { mode: 0o700 });
process.chdir(home);
const { meshFile, spaceSegment } = await import("@cotal-ai/workspace");

const socket = join(disk, "run/cotal/daemon.sock");
const records = join(home, "daemon");
const nameFile = join(records, "computer-name.json");
assert.notEqual(statSync(home).dev, statSync(records).dev, "name and settings must live on separate mounts");
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const atomicMessage = "The disk is full, so this change wasn't saved. Free up space on this computer, then try again.";
const multiMessage = "The disk is full, so Cotal can't tell whether this change was saved. Free up space on this computer, then try again.";
const daemon = spawn(process.execPath, [cli, "daemon", "serve"], { stdio: ["ignore", "inherit", "inherit"] });
let exited = false;
daemon.once("exit", () => { exited = true; });

function frame(op, fields = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const client = connect(socket);
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${op} reply`)), timeout);
    let text = "";
    function finish(error, reply) {
      clearTimeout(timer);
      client.destroy();
      if (error) reject(error);
      else resolve(reply);
    }
    client.setEncoding("utf8");
    client.on("connect", () => client.write(JSON.stringify({ v: 1, id: "probe", op, ...fields }) + "\n"));
    client.on("error", finish);
    client.on("end", () => finish(new Error(`socket ended without a ${op} reply`)));
    client.on("data", chunk => {
      text += chunk;
      if (!text.includes("\n")) return;
      try {
        const reply = JSON.parse(text.split("\n")[0]);
        assert.equal(reply.v, 1);
        assert.equal(reply.id, "probe");
        assert.equal(typeof reply.ok, "boolean");
        finish(null, reply);
      } catch (error) { finish(error); }
    });
  });
}

async function status(timeout) {
  const reply = await frame("status", {}, timeout);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.result.pid, daemon.pid, "same daemon is still answering");
  return reply.result;
}

async function waitReady() {
  const deadline = Date.now() + 30_000;
  let last;
  while (!exited && Date.now() < deadline) {
    try { await status(Math.min(1000, deadline - Date.now())); return; }
    catch (error) { last = error; }
    await delay(150);
  }
  throw new Error("daemon never became ready", { cause: last });
}

function run(args, expected, message) {
  const result = spawnSync(process.execPath, [cli, "daemon", ...args], { encoding: "utf8", timeout: 12_000, killSignal: "SIGKILL" });
  if (result.error) throw result.error;
  const out = result.stdout + result.stderr;
  assert.equal(result.status, expected, out);
  if (typeof message === "string") assert.ok(out.includes(message), out);
  else if (message) assert.match(out, message);
}

function exhaust(mount) {
  const fill = join(mount, "fill");
  const fd = openSync(fill, "wx", 0o600);
  try {
    const { blocks, bsize } = statfsSync(mount);
    const page = Buffer.alloc(bsize);
    assert.throws(() => {
      for (let i = 0; i <= blocks; i++) writeSync(fd, page);
    }, { code: "ENOSPC" });
    assert.equal(statfsSync(mount).bavail, 0);
  } finally { closeSync(fd); }
  return fill;
}

function exhaustInodes() {
  const dir = join(records, "inodes");
  mkdirSync(dir);
  const { files } = statfsSync(records);
  assert.throws(() => {
    for (let i = 0; i <= files; i++) closeSync(openSync(join(dir, String(i)), "wx", 0o600));
  }, { code: "ENOSPC" });
  const space = statfsSync(records);
  assert.equal(space.ffree, 0);
  assert.ok(space.bfree > 0, "inode exhaustion leaves free blocks");
  return dir;
}

function snapshot(file) {
  const files = readdirSync(dirname(file)).filter(name => name.startsWith(basename(file))).sort();
  return { bytes: readFileSync(file), files };
}

async function nameCell() {
  const file = nameFile;
  run(["name", "before-full"], 0);
  const before = snapshot(file);
  const fill = exhaust(records);
  run(["name", "probe-disk-full"], 5, atomicMessage);
  run(["name", "bad\nname"], 1);
  assert.deepEqual(snapshot(file), before);
  assert.equal((await status()).diskFull, true);
  run(["status"], 0, /\bDisk:\s+full\. Free up space on this computer\. Cotal continues by itself once there is room\./);
  assert.equal((await status()).diskFull, true);
  rmSync(fill);
  assert.equal((await status()).diskFull, undefined, "status recheck recovers before any new mutation");
  run(["name", "after-free"], 0);
  assert.match(readFileSync(file, "utf8"), /after-free/);
  console.log("  ✓ name exits, status row and read recovery");
}

async function settingsCell() {
  const file = join(home, "update-settings.json");
  const settings = (value) => ({ v: 1, auto: value, notify: value });
  const update = (value) => frame("update-settings", { auto: value, notify: value });
  assert.equal((await update(false)).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), settings(false));
  const before = snapshot(file);
  assert.deepEqual(before.files, ["update-settings.json"]);
  const fill = exhaust(disk);
  assert.deepEqual(await update(true), { v: 1, id: "probe", ok: false, error: { code: "OPERATION_FAILED", message: atomicMessage } });
  assert.deepEqual(snapshot(file), before, "failed dual-field update preserves bytes and record count");
  assert.equal((await status()).diskFull, true);
  const rename = await frame("name", { name: "healthy-mount" });
  assert.equal(rename.ok, true, JSON.stringify(rename));
  assert.match(readFileSync(nameFile, "utf8"), /healthy-mount/);
  assert.equal(rename.result.diskFull, true, "a name write on another mount must not clear the settings failure");
  assert.deepEqual(snapshot(file), before);
  rmSync(fill);
  const retry = await update(true);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.result.diskFull, undefined, "successful write clears disk-full state");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), settings(true));
  assert.deepEqual(snapshot(file).files, before.files);
  console.log("  ✓ dual-field settings refusal survives a healthy name write, preserves bytes and count, then recovers");
}

async function managerCell() {
  const space = "disk-full-smoke";
  const idp = "https://idp.example.invalid";
  const registration = meshFile(space);
  mkdirSync(dirname(registration), { mode: 0o700 });
  writeFileSync(registration, JSON.stringify({ space, root: home, server: "nats://127.0.0.1:1", mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: {
    provider: "cotal", remote: true, idp: { url: idp, issuer: idp, audience: idp }, endpoints: { url: idp },
  } }), { mode: 0o600, flag: "wx" });
  const start = () => frame("manager-start", { space });
  const file = join(records, spaceSegment(space), "manager-refusal.json");
  const expectSignInRefusal = reply => {
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.state, "refused");
    assert.match(reply.result.reason, /has no sign-in for this space's provider/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).reason, reply.result.reason);
  };
  expectSignInRefusal(await start());
  const before = snapshot(file);
  const inode = statSync(file).ino;
  const inodes = exhaustInodes();
  assert.deepEqual(await start(), { v: 1, id: "probe", ok: false, error: { code: "OPERATION_FAILED", message: multiMessage } });
  assert.deepEqual(snapshot(file), before);
  assert.equal((await status()).diskFull, true, "free blocks do not clear inode exhaustion");
  rmSync(inodes, { recursive: true });
  expectSignInRefusal(await start());
  assert.notEqual(statSync(file).ino, inode, "retry published a new refusal record");
  assert.equal((await status()).diskFull, undefined);
  console.log("  ✓ configured Manager start reports inode ENOSPC despite free blocks, then saves its refusal");
}

await waitReady();
await nameCell();
await settingsCell();
await managerCell();
// Exiting PID 1 reaps the daemon and any descendants, even after a failed assertion.
process.exit(0);
