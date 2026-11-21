import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";
import {
  beginGlobalUpdateChild, claimGlobalNpmUpdateLock, claimUpdateClosureAccess, updateClosureOwner, writeUpdateRecovery,
} from "@cotal-ai/workspace";

async function until(predicate: () => boolean, reason: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, reason);
    await delay(20);
  }
}

const [role, fixtureRoot, detail, fixtureVersion] = process.argv.slice(2) as [string, string, string, string];
if (role === "parent" || role === "writer") {
  const root = fixtureRoot;
  if (role === "parent") {
    claimGlobalNpmUpdateLock(join(root, "prefix/lib/node_modules"));
    claimUpdateClosureAccess(true);
    const snapshot = join(root, "config/cotal/sets/old/.update-snapshot-old");
    mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    writeUpdateRecovery({ previous: "0.1.0", target: fixtureVersion, installed: fixtureVersion, phase: "replacing",
      snapshot, reason: "reconciliation in progress", owner: updateClosureOwner() });
    const mutation = beginGlobalUpdateChild(join(root, "prefix/lib/node_modules"), "reconcile", true);
    mutation.markLive(Number(detail));
    writeFileSync(join(root, "parent-ready"), "");
    await until(() => false, "test did not interrupt updater", 60_000);
  } else {
    await until(() => existsSync(join(root, "begin-write")), "test did not let the survivor start writing");
    const release = claimUpdateClosureAccess(true);
    try {
      writeFileSync(join(root, "writer-ready"), "");
      await until(() => existsSync(join(root, "finish-write")), "test did not let the survivor finish writing");
    } finally { release(); }
  }
  process.exit(0);
}

if (process.platform !== "linux") skipSuite("installed current-package fast path requires Linux");

const root = mkdtempSync(join(tmpdir(), "update-orphan-"));
const repo = join(import.meta.dirname, "../..");
const installed = join(root, "prefix/lib/node_modules/cotal-ai");
const entry = join(installed, "dist/cotal.js");
const seed = join(root, "config/cotal/seed");
const state = join(root, "state");
const receipt = join(state, "update-recovery.json");
const marker = join(dirname(installed), ".cotal-update-child");
const native = join(root, "native");
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(COTAL_|npm_config_)/i.test(name))),
  HOME: join(root, "home"), COTAL_HOME: state, XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: join(root, "run"), PATH: `${native}${delimiter}${process.env.PATH}`,
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
  UPDATE_FIXTURE_ROOT: root,
};
const owned: { child: ChildProcess; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }[] = [];
function start(args: string[]) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  let output = "";
  let finished = false;
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  owned.push({ child, done });
  return { child, done, output: () => output, finished: () => finished };
}

async function cli(...args: string[]) {
  const run = start([entry, ...args]);
  const { code } = await run.done;
  return { code, output: run.output() };
}

let passed = false;
try {
  for (const path of [env.HOME!, state, env.XDG_RUNTIME_DIR!, native, seed, join(root, "prefix/bin"), join(root, ".cotal")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  cpSync(join(repo, "bin/dist"), dirname(entry), { recursive: true });
  cpSync(join(repo, "bin/package.json"), join(installed, "package.json"));
  symlinkSync(join(repo, "bin/node_modules"), join(installed, "node_modules"));
  symlinkSync(entry, join(root, "prefix/bin/cotal"));
  const { version } = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { version: string };
  // A healthy generation whose built-ins have all been deliberately removed.
  for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
  writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
  writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));
  for (const name of ["systemctl", "loginctl", "busctl", "launchctl", "schtasks"])
    writeFileSync(join(native, name), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  writeFileSync(join(native, "npm"), `#!/bin/sh
if [ "$1" = 'view' ] && [ "$2" = 'cotal-ai@latest' ]; then
  if [ -e "$UPDATE_FIXTURE_ROOT/arm" ]; then
    touch "$UPDATE_FIXTURE_ROOT/registry-requested"
    for attempt in $(seq 1 500); do
      [ -e "$UPDATE_FIXTURE_ROOT/writer-ready" ] && break
      sleep 0.02
    done
    [ -e "$UPDATE_FIXTURE_ROOT/writer-ready" ] || exit 99
  fi
  printf '%s\\n' '"${version}"'
else
  echo 'unexpected npm command' >&2
  exit 99
fi
`, { mode: 0o700 });

  const control = await cli("update", "--self");
  assert.equal(control.code, 0, control.output);
  assert.match(control.output, /installed package closure is current/);
  const before = await cli("status", "--json");
  assert.equal(before.code, 0, before.output);
  assert.doesNotMatch(before.output, /INSTALLATION_CHANGING/);
  console.log("Positive control: installed update --self and status both exited 0 with no writer.");

  const helper = (role: string, detail: string) => start([...process.execArgv, import.meta.filename, role, root, detail, version]);
  // Track both PIDs as direct children of this smoke, so it can reap both even after updater death.
  const writer = helper("writer", "");
  const parent = helper("parent", String(writer.child.pid));
  await until(() => existsSync(join(root, "parent-ready")) || parent.finished(), "updater did not publish its child");
  assert.equal(parent.finished(), false, parent.output());
  assert.ok(parent.child.kill("SIGKILL"));
  assert.equal((await parent.done).signal, "SIGKILL");
  const original = readFileSync(receipt);
  writeFileSync(join(root, "arm"), "");
  const retry = start([entry, "update", "--self"]);
  const requested = () => existsSync(join(root, "registry-requested"));
  const notice = "Waiting for the previous update's child to finish";
  const waiting = () => retry.output().includes(notice);
  await until(() => requested() || waiting() || retry.finished(), "retry reached neither package lookup nor writer wait");
  writeFileSync(join(root, "begin-write"), "");
  await until(() => existsSync(join(root, "writer-ready")) || writer.finished(), "survivor did not acquire the installation writer");
  assert.equal(writer.finished(), false, writer.output());
  if (requested()) {
    assert.fail("update --self checked the latest version before its surviving reconcile child released custody");
  }
  assert.ok(waiting(), retry.output());
  assert.equal(retry.finished(), false, retry.output());
  assert.deepEqual(readFileSync(receipt), original, "the journal must survive while the child can still write");
  const busy = await cli("status", "--json");
  assert.equal(busy.code, 4, busy.output);
  assert.match(busy.output, new RegExp(`another cotal command \\(pid ${writer.child.pid}\\) is changing this installation`));
  writeFileSync(join(root, "finish-write"), "");
  assert.equal((await writer.done).code, 0, writer.output());
  assert.equal((await retry.done).code, 0, retry.output());
  assert.match(retry.output(), /installed package closure is current/);
  assert.equal(retry.output().split(notice).length, 2, "the retry announces its wait once");
  assert.ok(retry.output().indexOf("Retained unusable interrupted-update records") > retry.output().indexOf(notice), retry.output());
  const retained = readdirSync(state).filter(name => name.startsWith("update-recovery-retained-"));
  assert.equal(retained.length, 1);
  assert.deepEqual(readFileSync(join(state, retained[0]!, "update-recovery.json")), original);
  const after = await cli("status", "--json");
  assert.equal(after.code, 0, after.output);
  assert.doesNotMatch(after.output, /INSTALLATION_CHANGING/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(state, ".update-closure.lock")), false);
  console.log("Retry waited for the reconciliation child; immediate status exited 0.");
  passed = true;
} finally {
  writeFileSync(join(root, "writer-ready"), "");
  writeFileSync(join(root, "finish-write"), "");
  for (const { child } of owned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.allSettled(owned.map(({ done }) => done));
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`Retained update smoke state: ${root}`);
}
emitSentinel({ passed: 2, failed: 0 });
