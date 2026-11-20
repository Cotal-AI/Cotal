import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { countedAssert, emitSentinel, freePort, killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("interrupted npm reconciliation fixture requires Linux");

const check: ReturnType<typeof countedAssert<typeof assert>> = countedAssert(assert);
const root = mkdtempSync(join(tmpdir(), "uor-"));
const repo = join(import.meta.dirname, "../..");
const prefix = join(root, "prefix"), modules = join(prefix, "lib/node_modules");
const installed = join(modules, "cotal-ai"), entry = join(installed, "dist/cotal.js");
const home = join(root, "home"), cotal = join(root, "cotal"), config = join(root, "config");
const native = join(root, "native"), project = join(root, "project"), runtime = join(root, "rt");
const seed = join(config, "cotal/seed"), snapshot = join(config, "cotal/sets/.update-snapshot-old");
for (const dir of [installed, join(prefix, "bin"), home, cotal, project, native, runtime, seed, snapshot])
  mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const file of ["systemctl", "loginctl", "busctl", "launchctl", "schtasks"])
  writeFileSync(join(native, file), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
cpSync(join(repo, "bin/dist"), join(installed, "dist"), { recursive: true });
cpSync(join(repo, "bin/package.json"), join(installed, "package.json"));
symlinkSync(join(repo, "bin/node_modules"), join(installed, "node_modules"));
symlinkSync(entry, join(prefix, "bin/cotal"));

const version = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version as string;
// The built-ins were seeded then removed. No package reinstall is needed on the current CLI.
for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));

const packument = JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } });
let stallRegistry = false;
let request: ServerResponse | undefined;
const registry = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  if (stallRegistry) request = response;
  else response.end(packument);
});
await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
const address = registry.address();
assert(address && typeof address === "object");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !/^npm_config_/i.test(key))),
  HOME: home, COTAL_HOME: cotal, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, TMPDIR: root,
  PATH: `${native}:${process.env.PATH}`, COTAL_NO_UPDATE_CHECK: "1", COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1",
  npm_config_registry: `http://127.0.0.1:${address.port}`, npm_config_cache: join(root, "npm-cache"),
};
function run(args: string[]) {
  const child = spawn(process.execPath, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"],
    ...(args[1] === "up" ? {} : { timeout: 90_000 }) });
  let text = "";
  child.stdout?.on("data", data => { text += data; });
  child.stderr?.on("data", data => { text += data; });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; text: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, text }));
  });
  return { child, result };
}
const cli = (...args: string[]) => run([entry, ...args]);
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(ready: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!ready()) {
    assert(Date.now() < deadline, description);
    await pause();
  }
}

const workspace = pathToFileURL(join(repo, "packages/workspace/dist/index.js")).href;
const update = pathToFileURL(join(repo, "implementations/cli/dist/commands/update.js")).href;
const ready = join(root, "child-ready"), enter = join(root, "child-enter"), leave = join(root, "child-leave");
const finished = join(root, "child-finished"), journal = join(cotal, "update-recovery.json");
const closure = join(cotal, ".update-closure.lock"), reservation = join(modules, ".cotal-update.lock");
const marker = join(modules, ".cotal-update-child");
// Use the real global child publisher and both production locks. The child models the older
// reconciliation process taking its own closure after the parent dies, with test-controlled timing.
const writer = `
  import { existsSync, writeFileSync } from 'node:fs';
  import { claimUpdateClosureAccess } from ${JSON.stringify(workspace)};
  const pause = () => new Promise(resolve => setTimeout(resolve, 20));
  writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  const deadline = Date.now() + 60_000;
  while (!existsSync(${JSON.stringify(enter)}) && Date.now() < deadline) await pause();
  if (!existsSync(${JSON.stringify(enter)})) process.exit(1);
  const release = claimUpdateClosureAccess(true);
  try { while (!existsSync(${JSON.stringify(leave)}) && Date.now() < deadline) await pause(); }
  finally { release(); writeFileSync(${JSON.stringify(finished)}, 'done'); }
`;
const launch = `
  import { claimGlobalNpmUpdateLock, claimUpdateClosureAccess, updateClosureOwner, writeUpdateRecovery } from ${JSON.stringify(workspace)};
  import { updateRuntime } from ${JSON.stringify(update)};
  const global = claimGlobalNpmUpdateLock(${JSON.stringify(modules)});
  const release = claimUpdateClosureAccess();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_UPDATE_CLOSURE_')));
  writeUpdateRecovery({ previous: '0.171.5', target: ${JSON.stringify(version)}, installed: '0.171.5', phase: 'replacing',
    snapshot: ${JSON.stringify(snapshot)}, owner: updateClosureOwner(), reason: 'global replacement in progress' });
  try { await updateRuntime.spawnGlobal(${JSON.stringify(modules)}, 'reconcile', process.execPath,
    ['--input-type=module', '-e', ${JSON.stringify(writer)}], env, true); }
  finally { release(); global(); }
`;

let up: ReturnType<typeof run> | undefined;
let original: ReturnType<typeof run> | undefined;
let retry: ReturnType<typeof run> | undefined;
try {
  const created = await cli("space", "create", "update-orphan").result;
  check.assert.equal(created.code, 0, created.text);
  up = cli("up", "--foreground", "--open", "--no-manager", "--space", "update-orphan", "--server", `nats://127.0.0.1:${await freePort()}`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const who = await cli("who").result;
    if (who.code === 0) break;
    assert(Date.now() < deadline && up.child.exitCode === null, who.text);
    await pause();
  }
  const current = await cli("update", "--self").result;
  check.assert.equal(current.code, 0, current.text);
  check.assert.match(current.text, /installed package closure is current/);
  const control = await cli("status").result;
  check.assert.equal(control.code, 0, control.text);
  console.log(`current installation: update=${current.code}, status=${control.code}`);

  original = run(["--input-type=module", "-e", launch]);
  await until(() => existsSync(ready), "the published reconciliation child did not start");
  const pid = Number(readFileSync(ready, "utf8"));
  check.assert.equal(JSON.parse(readFileSync(marker, "utf8")).pid, pid);
  check.assert.equal(JSON.parse(readFileSync(marker, "utf8")).owner, original.child.pid);
  original.child.kill("SIGKILL");
  await new Promise<void>(resolve => original!.child.once("exit", () => resolve()));
  check.assert.equal(original.child.signalCode, "SIGKILL");
  process.kill(pid, 0);
  const journalBefore = readFileSync(journal, "utf8");

  stallRegistry = true;
  retry = cli("update", "--self");
  const ownsReservation = () => {
    try { return JSON.parse(readFileSync(reservation, "utf8")).pid === retry!.child.pid; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  await until(() => Boolean(request) || ownsReservation(), "the retry neither waited for custody nor reached npm");
  const checkedTooSoon = request !== undefined;
  writeFileSync(enter, "enter");
  await until(() => existsSync(closure) && JSON.parse(readFileSync(closure, "utf8")).pid === pid, "the orphan did not take the installation writer");
  stallRegistry = false;
  if (checkedTooSoon) {
    request!.end(packument);
    const early = await retry.result;
    const status = await cli("status").result;
    const who = await cli("who").result;
    console.log(early.text + status.text + who.text);
    console.log(`retry=${early.code}, status=${status.code}, who=${who.code}, orphan writer pid=${pid}`);
    check.assert.fail("the retry reached the registry before the surviving reconciliation finished");
  }
  check.assert.equal(readFileSync(journal, "utf8"), journalBefore, "the retry must not retire recovery while the child can write");
  check.assert.equal(retry.child.exitCode, null);
  writeFileSync(leave, "leave");
  const updated = await retry.result;
  check.assert.equal(updated.code, 0, updated.text);
  check.assert.match(updated.text, /installed package closure is current/);
  const retained = readdirSync(cotal).filter(name => name.startsWith("update-recovery-retained-"));
  check.assert.equal(retained.length, 1);
  check.assert.equal(readFileSync(join(cotal, retained[0]!, "update-recovery.json"), "utf8"), journalBefore);
  check.assert.equal(existsSync(closure), false, "no installation writer remains when retry succeeds");
  check.assert.equal(existsSync(marker), false, "the dead reconciliation child marker was reaped");
  const status = await cli("status").result;
  check.assert.equal(status.code, 0, status.text);
  const who = await cli("who").result;
  check.assert.equal(who.code, 0, who.text);
  console.log(`after waiting for the orphan: retry=${updated.code}, status=${status.code}, who=${who.code}`);
} finally {
  writeFileSync(enter, "enter");
  writeFileSync(leave, "leave");
  stallRegistry = false;
  if (request && !request.writableEnded) request.end(packument);
  if (retry) { await killAndAwaitExit(retry.child); await retry.result; }
  if (original) {
    if (original.child.exitCode === null && original.child.signalCode === null) original.child.kill();
    await original.result;
    if (existsSync(ready)) await until(() => existsSync(finished), "the owned orphan writer did not release its lock");
  }
  if (up) { await killAndAwaitExit(up.child); await up.result; }
  await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve()));
}
emitSentinel({ passed: check.cells(), failed: 0 });
