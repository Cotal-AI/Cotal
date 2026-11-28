import { once } from "node:events";
import strictAssert from "node:assert/strict";
import { isReachable } from "@cotal-ai/core";
import { awaitBrokerReady, countedAssert, emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { ConnectRefusal, identityRecord } from "@cotal-ai/workspace";
import { readUpdateManagerContinuity, reportRunningManagers } from "../src/commands/update.js";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const seen: Record<string, unknown>[] = [];
const ownProcess = identityRecord(process.pid);
assert.ok("token" in ownProcess);
if (!("token" in ownProcess)) throw new Error("smoke process must have a native identity");
const retained = { retainGraph: true };
const manager = { process: ownProcess, space: 'other "space"', server: "nats://127.0.0.1:4222", root: '/other "home"', instanceId: "localtwo", pid: process.pid };
const missing = new ConnectRefusal("missing", undefined, { code: "AUTH_REQUIRED", native: { code: "CREDENTIALS_MISSING" } });
const signedOut = new ConnectRefusal("signed out", undefined, { code: "AUTH_REQUIRED", cause: { code: "signed-out" } });
const notices: string[] = [];
const log = console.log;
console.log = text => { notices.push(String(text)); };
try {
  for (const error of [missing, signedOut]) {
    const before = notices.length;
    assert.equal(await readUpdateManagerContinuity(manager, {}, async flags => {
      assert.deepEqual(flags, { space: manager.space, server: manager.server, on: manager.instanceId });
      throw error;
    }, retained), "none");
    assert.equal(notices.length, before + 1, "one missing-credentials notice per read");
    assert.ok(notices.at(-1)!.includes(JSON.stringify(manager.space)));
    assert.ok(notices.at(-1)!.includes(JSON.stringify(manager.root)));
    assert.ok(notices.at(-1)!.includes(manager.instanceId));
    assert.ok(notices.at(-1)!.includes("keeps running the version it loaded until it is restarted from its own home"));
  }
  for (const error of [
    new ConnectRefusal("expired", undefined, { code: "AUTH_REQUIRED" }),
    new ConnectRefusal("rejected", undefined, { code: "PERMISSION_DENIED" }),
    new ConnectRefusal("refused", undefined, { code: "PERMISSION_DENIED", cause: { code: "refused" } }),
    Object.assign(new Error("unreadable credentials"), { code: "EACCES" }),
    Object.assign(new Error("untyped missing"), { native: { code: "CREDENTIALS_MISSING" } }),
  ]) await assert.rejects(readUpdateManagerContinuity(manager, {}, async () => { throw error; }, retained), actual => actual === error);
  await assert.rejects(readUpdateManagerContinuity(manager, { creds: "/explicit.creds" }, async () => { throw missing; }, retained), actual => actual === missing);
  await assert.rejects(readUpdateManagerContinuity(manager, {}, async () => { throw missing; }), actual => actual === missing, "nonretained reads still refuse");
  await assert.rejects(readUpdateManagerContinuity({ ...manager, process: undefined }, {}, async () => { throw missing; }, retained), actual => actual === missing, "missing native pin still refuses");
  await assert.rejects(reportRunningManagers({}, async () => { throw missing; }, () => [manager]), actual => actual === missing, "generic report cannot absorb missing credentials");
  assert.equal(await reportRunningManagers({}, async () => { throw missing; }, () => [manager], retained), "none", "retained report uses known local Manager boundary");
  const foreign = { ownership: "foreign" as const, pid: process.pid, root: "/foreign", space: "foreign", process: ownProcess };
  assert.equal(await readUpdateManagerContinuity(foreign, {}, async () => { throw new Error("foreign must not resolve auth"); }), "none");
  // Another home's Manager never changes the outcome of this home's own selection: every case
  // below must read what an empty census reads, after one notice.
  for (const flags of [{}, { server: "nats://127.0.0.1:4222" }, { space: "foreign", on: "0123456789abcdefghijklmnopqrstuv" }]) {
    const reads: Record<string, unknown>[] = [];
    const before = notices.length;
    assert.equal(await reportRunningManagers(flags, async selected => { reads.push(selected); return "legacy"; }, () => [foreign], retained), "legacy", "the selected mesh is still read beside a foreign Manager");
    assert.deepEqual(reads, [flags], "the read is the one an empty census makes");
    assert.equal(notices.length, before + 1, "one notice names the foreign Manager");
  }
  await assert.rejects(reportRunningManagers({ on: "0123456789abcdefghijklmnopqrstuv" }, async () => "none", () => [foreign, manager]), /does not name a local Manager/, "an own local Manager still makes an unknown --on a refusal");
  await assert.rejects(readUpdateManagerContinuity(foreign, { creds: "/explicit.creds" }, async flags => {
    assert.deepEqual(flags, { creds: "/explicit.creds" });
    throw missing;
  }), actual => actual === missing);
  assert.equal(await readUpdateManagerContinuity(manager, {}, async () => "legacy"), "legacy", "answered legacy is unchanged");
  assert.equal(await readUpdateManagerContinuity(manager, {}, async () => "none"), "none");
  const processRecord = identityRecord(process.pid);
  assert.ok("token" in processRecord);
  if ("token" in processRecord) {
    const pinned = { ...manager, process: { ...processRecord } };
    await assert.rejects(readUpdateManagerContinuity(pinned, {}, async () => {
      pinned.process.token = "changed";
      throw missing;
    }, retained), /changed during its continuity read/);
    await assert.rejects(readUpdateManagerContinuity(pinned, {}, async () => "none"), /changed during its continuity read/);
    pinned.process.token = processRecord.token;
    await assert.rejects(readUpdateManagerContinuity(pinned, {}, async () => {
      pinned.process.token = "changed";
      return "legacy";
    }, retained), /changed during its continuity read/);
  }
} finally { console.log = log; }
// The selected mesh must not decide which local Managers share the installation.
const report = reportRunningManagers as unknown as (
  flags: Record<string, unknown>,
  read: (flags: Record<string, unknown>) => Promise<"none" | "legacy">,
  census: () => { space: string; server: string; root: string; instanceId: string; pid: number }[],
) => Promise<"none" | "legacy">;
await report({}, async flags => { seen.push(flags); return "none"; }, () => [
  { space: "A", server: "nats://127.0.0.1:4222", root: "/a", instanceId: "0123456789abcdefghijklmnopqrstuv", pid: 1 },
  { space: "A", server: "nats://127.0.0.1:4222", root: "/b", instanceId: "localtwo", pid: 2 },
]);
assert.deepEqual(seen.map(flags => [flags.space, flags.on]), [["A", "0123456789abcdefghijklmnopqrstuv"], ["A", "localtwo"]]);
seen.length = 0;
await report({ space: "B" }, async flags => { seen.push(flags); return "none"; }, () => [
  { space: "A", server: "nats://127.0.0.1:4222", root: "/a", instanceId: "0123456789abcdefghijklmnopqrstuv", pid: 1 },
]);
assert.deepEqual([...seen], [{ space: "B" }], "an explicit space still narrows the report");
seen.length = 0;
await report({ creds: "/explicit.creds" }, async flags => { seen.push(flags); return "none"; }, () => { throw Error("raw credentials must not enumerate unrelated Managers"); });
assert.deepEqual(seen, [{ creds: "/explicit.creds" }]);
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { spaceKey, recordMesh } = await import("@cotal-ai/workspace");
const { readUpdateManagerIdentity } = await import("../src/lib/update-managers.js");
const { isCliEntry, supervisorInstallScope } = await import("../src/lib/manager-proc.js");
const { fileURLToPath } = await import("node:url");
assert.equal(isCliEntry(fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url))), true, "checkout entry remains attributable across bin/package.json");
const ownEntry = (await import("node:fs")).realpathSync(process.argv[1]!);
const uid = process.getuid!();
assert.equal(supervisorInstallScope(process.pid, uid + 1, "node /unresolvable/foreign/cotal.js supervise", ownEntry), "foreign", "foreign user with no same-install entry is excluded");
assert.equal(supervisorInstallScope(process.pid, uid + 1, `node ${ownEntry} supervise`, ownEntry), "local", "sudo supervisor of this installation still counts");
assert.equal(supervisorInstallScope(process.pid, uid, `node ${ownEntry} supervise`, ownEntry), "local", "same-user supervisor of this installation still counts");
assert.equal(supervisorInstallScope(process.pid, uid, "node cotal.js supervise", ownEntry), "unknown", "relative missing entry does not prove another installation");
assert.equal(supervisorInstallScope(2147483647, uid, "node cotal.js supervise", ownEntry), "unknown", "unreadable namespace does not establish safety");
const root = mkdtempSync(join(tmpdir(), "cotal-update-identity-"));
try {
  mkdirSync(join(root, ".cotal", "auth"), { recursive: true });
  const file = join(root, ".cotal", "auth", `manager-instance.${spaceKey("A")}.json`);
  const bytes = JSON.stringify({ instanceId: "0123456789abcdefghijklmnopqrstuv", serveIdentity: { id: "unused", seed: "unused" } });
  writeFileSync(file, bytes);
  assert.equal(readUpdateManagerIdentity(root, "A"), "0123456789abcdefghijklmnopqrstuv");
  assert.equal(readFileSync(file, "utf8"), bytes, "legacy identity is retained without migration");
  assert.throws(() => readUpdateManagerIdentity(root, "missing"), /missing identity/);
  writeFileSync(file, "{}");
  assert.throws(() => readUpdateManagerIdentity(root, "A"), /invalid identity/);
} finally { rmSync(root, { recursive: true, force: true }); }
// A real argv-bearing process with a missing identity must not poison another explicit space.
if (process.platform === "linux") {
  const { spawn } = await import("node:child_process");
  const fixture = mkdtempSync(join(tmpdir(), "cotal-update-census-process-"));
  const entry = join(fixture, "cotal.ts");
  writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  const foreignHome = process.env.COTAL_HOME;
  const sandboxHome = mkdtempSync(join(tmpdir(), "cotal-update-foreign-home-"));
  process.env.COTAL_HOME = sandboxHome;
  const child = spawn(process.execPath, [entry, "supervise", "--space", "unrelated", "--server", "nats://127.0.0.1:4222"], { cwd: fixture, stdio: "ignore" });
  const priorEntry = process.argv[1];
  try {
    await once(child, "spawn");
    process.argv[1] = entry;
    const { localUpdateManagers } = await import("../src/lib/update-managers.js");
    const scoped = localUpdateManagers as unknown as (flags: { space: string }) => unknown[];
    const foreign = localUpdateManagers({ space: "unrelated" }, entry);
    assert.equal(foreign.length, 1, "native foreign Manager is observed without identity file");
    assert.equal(foreign[0]!.ownership, "foreign");
    assert.equal(foreign[0]!.instanceId, undefined, "foreign instance is explicitly unavailable");
    assert.equal(foreign[0]!.server, undefined, "foreign broker is never inferred");
    const alias = join(sandboxHome, "root-alias");
    (await import("node:fs")).symlinkSync(fixture, alias);
    recordMesh({ space: "alias-owner", root: alias, server: "nats://127.0.0.1:4222", mode: "open", origin: "manual", ts: new Date().toISOString() });
    assert.throws(() => localUpdateManagers({ space: "unrelated" }, entry), /missing identity/, "all registry roots include symlink aliases even under another space name");
    (await import("node:fs")).unlinkSync(alias);
    (await import("node:fs")).mkdirSync(alias);
    recordMesh({ space: "ancestor-owner", root: join(fixture, ".."), server: "nats://127.0.0.1:4222", mode: "open", origin: "manual", ts: new Date().toISOString() });
    assert.throws(() => localUpdateManagers({ space: "unrelated" }, entry), /missing identity/, "nested own-root cwd cannot become foreign");
    assert.deepEqual(scoped({ space: "selected" }), [], "unrelated missing identity is excluded before validation");
  } finally {
    process.argv[1] = priorEntry!;
    child.kill();
    await once(child, "exit");
    if (foreignHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = foreignHome;
    rmSync(sandboxHome, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
  const relativeRoot = mkdtempSync(join(tmpdir(), "cotal-update-relative-"));
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(relativeRoot, "home");
  recordMesh({ space: "relative-proof", root: relativeRoot, server: "nats://127.0.0.1:9", mode: "open", origin: "manual", ts: new Date().toISOString() });
  recordMesh({ space: "permission-proof", root: relativeRoot, server: "nats://127.0.0.1:9", mode: "open", origin: "manual", ts: new Date().toISOString() });
  const relativeEntry = join(relativeRoot, "entry.mjs");
  writeFileSync(relativeEntry, "setInterval(() => {}, 1000);\n");
  const otherRoot = join(relativeRoot, "other");
  mkdirSync(otherRoot);
  writeFileSync(join(otherRoot, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "cotal.js" } }));
  const otherEntry = join(otherRoot, "cotal.js");
  writeFileSync(otherEntry, "");
  const relativeChild = spawn(process.execPath, ["entry.mjs", "supervise", "--space", "relative-proof", "--server", "nats://127.0.0.1:9", otherEntry], { cwd: relativeRoot, stdio: "ignore" });
  try {
    await once(relativeChild, "spawn");
    const commandReady = () => { try { return readFileSync(`/proc/${relativeChild.pid}/cmdline`).length > 0; } catch { return false; } };
    const commandDeadline = Date.now() + 5_000;
    while (relativeChild.exitCode === null && Date.now() < commandDeadline && !commandReady()) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(commandReady(), true, "the relative fixture command is readable before the census");
    const { localUpdateManagers } = await import("../src/lib/update-managers.js");
    assert.throws(() => localUpdateManagers({ space: "relative-proof" }, relativeEntry), /missing identity/, "relative same-install entry is resolved before another absolute CLI argument can exclude it");
  } finally {
    relativeChild.kill();
    await once(relativeChild, "exit");
  }
  try {
    const { spawnSync } = await import("node:child_process");
    const binary = join(relativeRoot, "changing-entry");
    const compiled = spawnSync("cc", [fileURLToPath(new URL("./fixtures/supervisor-dumpability.c", import.meta.url)), "-o", binary], { encoding: "utf8" });
    assert.equal(compiled.status, 0, `native dumpability fixture compiles: ${compiled.stderr}`);
    const changing = spawn("./changing-entry", ["supervise", "--space", "permission-proof", "--server", "nats://127.0.0.1:9", otherEntry], { cwd: relativeRoot, stdio: "ignore" });
    try {
      await once(changing, "spawn");
      const { localUpdateManagers } = await import("../src/lib/update-managers.js");
      for (let attempt = 0; attempt < 50; attempt++) {
        assert.throws(() => localUpdateManagers({ space: "permission-proof" }, binary), /local Manager continuity cannot be established/, "changing dumpability must refuse local custody, never silently exclude it");
      }
    } finally {
      changing.kill();
      await once(changing, "exit");
    }
  } finally {
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
    rmSync(relativeRoot, { recursive: true, force: true });
  }
  await checkCoordinatesRace();
  await checkRenamedManagerInstall();
}

async function checkRenamedManagerInstall(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { copyFileSync, cpSync, existsSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { dirname, relative } = await import("node:path");
  const { localUpdateManagers } = await import("../src/lib/update-managers.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-update-mapped-install-")));
  const repo = join(import.meta.dirname, "../../..");
  const archPackage = `@lydell/node-pty-linux-${process.arch}`;
  const ptyFile = `prebuilds/linux-${process.arch}/pty.node`;
  const pty = createRequire(join(repo, "implementations/manager/package.json")).resolve("@lydell/node-pty");
  const nativePkg = dirname(dirname(createRequire(pty).resolve(archPackage)));
  const stage = (name: string) => {
    const prefix = join(root, name), installed = join(prefix, "lib/node_modules/cotal-ai");
    cpSync(join(repo, "bin/dist"), join(installed, "dist"), { recursive: true });
    copyFileSync(join(repo, "bin/package.json"), join(installed, "package.json"));
    const modules = join(installed, "node_modules");
    for (const scope of ["@cotal-ai", "@lydell"]) mkdirSync(join(modules, scope), { recursive: true });
    for (const name of readdirSync(join(repo, "bin/node_modules/@cotal-ai"))) {
      if (name !== "manager") symlinkSync(realpathSync(join(repo, "bin/node_modules/@cotal-ai", name)), join(modules, "@cotal-ai", name));
    }
    symlinkSync(realpathSync(join(repo, "bin/node_modules/jose")), join(modules, "jose"));
    const manager = join(modules, "@cotal-ai/manager");
    cpSync(join(repo, "implementations/manager/dist"), join(manager, "dist"), { recursive: true });
    copyFileSync(join(repo, "implementations/manager/package.json"), join(manager, "package.json"));
    mkdirSync(join(manager, "node_modules"));
    const managerModules = join(repo, "implementations/manager/node_modules");
    for (const name of readdirSync(managerModules)) {
      if (name !== "@lydell" && !name.startsWith(".")) symlinkSync(join(managerModules, name), join(manager, "node_modules", name));
    }
    cpSync(dirname(pty), join(modules, "@lydell/node-pty"), { recursive: true, dereference: true });
    cpSync(nativePkg, join(modules, archPackage), { recursive: true, dereference: true });
    return { prefix, entry: join(installed, "dist/cotal.js"), mapping: join(modules, archPackage, ptyFile) };
  };
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "NODE_OPTIONS" && key !== "NODE_PATH"));
  for (const path of ["home", "updater", "state", "config", "runtime", "tmp", "project"]) mkdirSync(join(root, path), { mode: 0o700 });
  Object.assign(env, { HOME: join(root, "home"), COTAL_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"), TMPDIR: join(root, "tmp"), DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1" });
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(root, "updater");
  try {
    const own = stage("own"), foreign = stage("foreign"), generated = stage("generated");
    const generationId = "0123456789abcdef0123456789abcdef";
    const logicalPkg = join(generated.prefix, "lib/node_modules/cotal-ai");
    const retained = join(generated.prefix, "lib/.cotal-generations", generationId, "cotal-ai");
    mkdirSync(dirname(retained), { recursive: true });
    renameSync(logicalPkg, retained);
    symlinkSync(join("..", ".cotal-generations", generationId, "cotal-ai"), logicalPkg);
    const current = join(dirname(dirname(retained)), "fedcba9876543210fedcba9876543210", "cotal-ai");
    mkdirSync(dirname(current), { recursive: true });
    cpSync(retained, current, { recursive: true, verbatimSymlinks: true });
    const generatedMapping = join(retained, "node_modules", archPackage, ptyFile);
    const alias = join(root, "alias"), aliasEntry = join(alias, "lib/node_modules/cotal-ai/dist/cotal.js");
    symlinkSync(own.prefix, alias);
    const space = "mapped-manager-install", port = await freePort(), server = `nats://127.0.0.1:${port}`;
    const store = mkdtempSync(join(root, SMOKE_BROKER_TOKEN));
    const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", store], { env, stdio: "ignore" });
    const releaseBroker = teardownOnSignal(broker, store);
    try {
      await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
      for (const [entry, mapping, mode] of [[foreign.entry, foreign.mapping, "foreign"], [generated.entry, generatedMapping, "generation"], [aliasEntry, own.mapping, "local"]] as const) {
        const child = spawn(process.execPath, [entry, "supervise", "--space", space, "--server", server], { cwd: join(root, "project"), env, stdio: ["ignore", "pipe", "pipe"] });
        const releaseChild = teardownOnSignal(child);
        let output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { output += chunk; });
        try {
          await once(child, "spawn");
          let deadline = Date.now() + 15_000;
          const maps = `/proc/${child.pid}/maps`;
          const mapped = (path = mapping) => existsSync(maps) && readFileSync(maps, "utf8").includes(path);
          const exeReady = () => { try { statSync(`/proc/${child.pid}/exe`); return true; } catch { return false; } };
          // The first map line and a readable exe can both vanish again while the process is still starting.
          const settled = async (path = mapping) => {
            let stable = false;
            while (child.exitCode === null && Date.now() < deadline && !stable) {
              stable = mapped(path) && exeReady();
              await new Promise(resolve => setTimeout(resolve, 25));
              stable &&= mapped(path) && exeReady();
            }
            return stable;
          };
          assert.ok(await settled(), `real Manager mapped its own PTY dependency: ${output}`);
          if (mode === "foreign" || mode === "generation") {
            if (mode === "generation") {
              assert.deepEqual(localUpdateManagers({ space }, own.entry), [], "a self-updated foreign Manager does not block while its launch entry resolves");
              const badId = join(generated.prefix, "lib/.cotal-generations/not-a-generation-id/cotal-ai");
              mkdirSync(dirname(badId), { recursive: true });
              renameSync(retained, badId);
              assert.throws(() => localUpdateManagers({ space }, own.entry), new RegExp(`local Manager continuity cannot be established: Manager pid ${child.pid}`), "a retained package whose generation id is not 32 hex digits stays unproven");
              const elsewhere = join(root, "elsewhere/.cotal-generations", generationId, "cotal-ai");
              mkdirSync(dirname(elsewhere), { recursive: true });
              renameSync(badId, elsewhere);
              const movedMapping = join(elsewhere, "node_modules", archPackage, ptyFile);
              deadline = Date.now() + 15_000;
              assert.ok(await settled(movedMapping), "maps show the retained package under its different parent");
              assert.throws(() => localUpdateManagers({ space }, own.entry), new RegExp(`local Manager continuity cannot be established: Manager pid ${child.pid}`), "a retained package under a different parent stays unproven");
              renameSync(elsewhere, retained);
              rmdirSync(dirname(badId));
              rmdirSync(dirname(elsewhere));
              rmdirSync(dirname(dirname(elsewhere)));
            }
            const prefix = mode === "foreign" ? foreign.prefix : generated.prefix;
            renameSync(prefix, `${prefix}.moved`);
            if (mode === "generation") {
              mkdirSync(prefix);
              assert.throws(() => localUpdateManagers({ space }, own.entry), new RegExp(`local Manager continuity cannot be established: Manager pid ${child.pid}`), "a directory at the old prefix is not inferred as a rename");
              rmdirSync(prefix);
            }
            assert.deepEqual(localUpdateManagers({ space }, own.entry), [], "a foreign Manager with a missing launch entry does not block");
            if (mode === "generation") {
              const currentEntry = join(`${prefix}.moved`, relative(prefix, current), "dist/cotal.js");
              assert.throws(() => localUpdateManagers({ space }, currentEntry), new RegExp(`Manager pid ${child.pid}.*has no proven CLI entry`), "an older own generation cannot be skipped as foreign");
            }
          } else {
            assert.ok(localUpdateManagers({ space }, own.entry).some(manager => manager.pid === child.pid), "a resolvable symlink into the installation retains Manager custody");
            renameSync(alias, `${alias}.moved`);
            assert.throws(() => localUpdateManagers({ space }, own.entry), new RegExp(`Manager pid ${child.pid}.*has no proven CLI entry`));
          }
          assert.equal(process.kill(child.pid!, 0), true, "the census never stops a Manager");
        } finally { await killAndAwaitExit(child); releaseChild(); }
      }
    } finally { await killAndAwaitExit(broker); releaseBroker(); }
  } finally {
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
}

async function checkCoordinatesRace(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { localUpdateManagers } = await import("../src/lib/update-managers.js");
  const read = fs.readFileSync;
  const root = mkdtempSync(join(tmpdir(), "cotal-update-coordinates-"));
  const entry = join(root, "cotal.cjs");
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(root, "update-home");
  writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const procState = (pid: number) => {
    try {
      const stat = read(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    } catch (error) { return (error as NodeJS.ErrnoException).code; }
  };
  const waitForState = (pid: number, state: string) => {
    const deadline = Date.now() + 5000;
    while (procState(pid) !== state) {
      if (Date.now() >= deadline) throw new Error(`pid ${pid} did not reach state ${state}`);
      Atomics.wait(pause, 0, 0, 1);
    }
  };
  try {
    // The foreign Manager is a child of this suite; it gets none of the runner's own connection material.
    const foreignEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
    for (const [mode, pinned] of [["gone", false], ["gone", true], ["zombie", false], ["zombie", true], ["unreadable", true]] as const) {
      // The reaper is separate from this synchronous scan and can be stopped to hold a real zombie.
      const parent = spawn("/bin/sh", ["-c", '"$NODE" "$ENTRY" "$VERB" --space coordinates-race >/dev/null & child=$!; echo "$child"; wait "$child"'], {
        cwd: root, stdio: ["ignore", "pipe", "inherit"],
        env: { ...foreignEnv, COTAL_HOME: join(root, "foreign-home"), NODE: process.execPath, ENTRY: entry, VERB: "supervise" },
      });
      const exit = once(parent, "exit");
      let pid: number | undefined;
      let signaled = false;
      let reached = false;
      try {
        const [output] = await once(parent.stdout!, "data");
        pid = Number(String(output).trim());
        assert.ok(Number.isSafeInteger(pid) && pid > 0, String(output));
        const childPid = pid;
        const proc = `/proc/${childPid}`;
        const deadline = Date.now() + 5000;
        while (!read(`${proc}/cmdline`, "utf8").includes("\0coordinates-race\0")) {
          if (Date.now() >= deadline) throw new Error(`pid ${childPid} did not reach fixture argv`);
          Atomics.wait(pause, 0, 0, 1);
        }
        if (mode === "zombie") {
          parent.kill("SIGSTOP");
          waitForState(parent.pid!, "T");
        }
        let cmdlineReads = 0;
        let statReads = 0;
        const denied = () => Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
        const scan = () => localUpdateManagers({ space: "coordinates-race" }, entry);
        fs.readFileSync = ((path: Parameters<typeof read>[0], ...args: unknown[]) => {
          if (!pinned && path === `${proc}/stat` && ++statReads === 1) throw denied();
          if (mode === "unreadable" && path === `${proc}/environ`) {
            reached = true;
            throw denied();
          }
          if (mode !== "unreadable" && path === `${proc}/cmdline` && ++cmdlineReads === 3) {
            process.kill(childPid, "SIGKILL");
            signaled = true;
            waitForState(childPid, mode === "gone" ? "ENOENT" : "Z");
            reached = true;
          }
          return Reflect.apply(read, fs, [path, ...args]);
        }) as typeof read;
        syncBuiltinESMExports();
        if (mode === "unreadable") {
          assert.throws(scan, new RegExp(`cannot read launch coordinates for Manager pid ${childPid},`));
          assert.equal(process.kill(childPid, 0), true, "a live Manager with unreadable environ still refuses");
        } else {
          assert.deepEqual(scan(), [], `${mode} Manager (${pinned ? "with" : "without"} creation pin) has no custody`);
        }
        assert.ok(reached, `${mode} cell reached the launch coordinate read`);
        if (!pinned) assert.ok(statReads > 1, "the initial creation pin was unreadable and liveness was checked again");
      } finally {
        fs.readFileSync = read;
        syncBuiltinESMExports();
        if (pid && !signaled) process.kill(pid, "SIGKILL");
        if (mode === "zombie") parent.kill("SIGCONT");
        await exit;
      }
    }
  } finally {
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
}

emitSentinel({ passed: counted.cells(), failed: 0 });
