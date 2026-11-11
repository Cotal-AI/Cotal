/** The shipped daemon must answer clients while its recorded native service is being verified. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { openVerified, queryDaemon } from "../daemon/client.js";
import { requestInstalledDaemon } from "../daemon/install.js";

if (process.platform !== "linux") skipSuite("daemon ownership responsiveness: recording Linux supervisor required");
const pending = process.argv.includes("--pending");
const retry = process.argv.includes("--retry") || pending;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "dor-"));
const home = join(root, "home"), config = join(root, "config"), runtime = join(root, "rt"), native = join(root, "native");
for (const directory of [home, config, runtime, native]) mkdirSync(directory, { mode: 0o700 });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: runtime, PATH: `${native}:${process.env.PATH}`, COTAL_DAEMON_NATIVE_SERVICE: "1", COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
const paths = daemonPaths(env, home);
mkdirSync(paths.state, { recursive: true, mode: 0o700 });
const entry = join(repo, "bin/dist/cotal.js");
const unitPath = join(config, "systemd/user/cotal-daemon.service");
mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
const source = `[Service]\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${process.execPath}" "${entry}" daemon serve\nRestart=always\n`;
writeFileSync(unitPath, source, { mode: 0o600 });
writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
const marker = join(root, "native-started"), finished = join(root, "native-finished"), count = join(root, "calls");
writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.slice(2).join(' ')!=='--user show-environment')process.exit(99);fs.appendFileSync(${JSON.stringify(count)},'query\\n');fs.writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{if (${retry} && !fs.existsSync(${JSON.stringify(join(root, "repaired"))})) { fs.writeFileSync(${JSON.stringify(finished)},'failed'); process.exit(1); } fs.writeFileSync(${JSON.stringify(finished)},'finished');console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});},1200);\n`, { mode: 0o700 });
const seed = join(config, "cotal/seed"); mkdirSync(seed, { recursive: true, mode: 0o700 });
const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version;
writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }), { mode: 0o600 });
const child = spawn(process.execPath, [entry, "daemon", "serve"], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; child.stdout.on("data", bytes => output += bytes); child.stderr.on("data", bytes => output += bytes);
try {
  for (let i = 0; !existsSync(marker); i++) { assert.ok(i < 300 && child.exitCode === null, `native verification never started: ${output}`); await delay(25); }
  assert.ok(!existsSync(finished), "probe begins while the real native tool is still running");
  const started = Date.now();
  const reply = await Promise.race([queryDaemon({ paths }), delay(500).then(() => { throw new Error("client status blocked while native ownership check is running"); })]);
  assert.ok(reply.ok && reply.result?.state === "ready", "actual bundled client reads ready daemon during native check");
  assert.ok(!existsSync(finished), "client reply precedes native check completion");
  console.log(`PASS real client status answered in ${Date.now() - started}ms while native verification is running`);
  if (!pending) await delay(1600);
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 1, "native ownership observation runs once");
  console.log("PASS exact native ownership observation runs once");
  if (retry) {
    if (pending) {
      writeFileSync(join(root, "repaired"), "ready");
      const socket = await openVerified({ paths });
      try {
        const started = Date.now();
        await requestInstalledDaemon(socket, "daemon-stop");
        assert.ok(Date.now() - started < 5000, "pending startup is replaced, not serially awaited");
        assert.ok(output.includes("native ownership unknown: observation-aborted"), "unfinished startup observation was aborted");
        console.log("PASS pending startup observation replaced within stop reply bound");
      } finally { socket?.destroy(); }
    } else {
      const socket = await openVerified({ paths });
      try {
        await assert.rejects(requestInstalledDaemon(socket, "daemon-stop"), /provenance is still unknown/);
        writeFileSync(join(root, "repaired"), "ready");
        const unmarked = source.replace("Environment=COTAL_DAEMON_NATIVE_SERVICE=1\n", "");
        const record = (bytes: string) => {
          writeFileSync(unitPath, bytes);
          writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(bytes).digest("hex"), installedAt: new Date().toISOString() }));
        };
        record(unmarked);
        await assert.rejects(requestInstalledDaemon(socket, "daemon-stop"), /has no verified native launch provenance/);
        assert.ok(output.includes("native ownership not-owned: source-marker-absent"), "unmarked verified source has definitive reason");
        record(source);
        await requestInstalledDaemon(socket, "daemon-stop");
        assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 4, "prepare re-observes failed startup ownership");
        await requestInstalledDaemon(socket, "daemon-stop");
        assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 4, "owned result is cached");
        assert.equal(output.split("native ownership unknown: observation-failed").length - 1, 1, "safe failure reason logged once");
        assert.ok(!output.includes(unitPath), "ownership log does not expose source paths");
        console.log("PASS distinct unknown and not-owned refusals retain daemon authority fences");
        console.log("PASS real daemon-stop retries failed startup observation and caches only owned");
      } finally { socket?.destroy(); }
    }
  }
} finally {
  await killAndAwaitExit(child, "SIGTERM");
  console.log(`Retained ownership responsiveness fixture: ${root}`);
}

if (retry) process.exit(0);

// Exercise the compiled observer too: a responsive daemon with authority always false
// would pass the request check but break native generation activation.
const { observeDaemonOwnedService } = await import(pathToFileURL(join(repo, "bin/dist/daemon/install.js")).href);
// Restoration-only entries, never a child environment.
const priorEnv = Object.entries(process.env), argv = process.argv, execArgv = process.execArgv;
try {
  Object.assign(process.env, env);
  process.argv = [process.execPath, entry]; process.execArgv = [];
  assert.equal((await observeDaemonOwnedService(paths)).state, "owned", "matching native source retains activation authority");
  console.log("PASS asynchronous observation verifies matching exact native source");
  delete process.env.COTAL_DAEMON_NATIVE_SERVICE;
  assert.deepEqual(await observeDaemonOwnedService(paths), { state: "not-owned", reason: "marker-absent" }, "foreground process is not a native service");
  process.env.COTAL_DAEMON_NATIVE_SERVICE = "1";
  writeFileSync(unitPath, source + "# changed\n");
  assert.equal((await observeDaemonOwnedService(paths)).state, "unknown", "changed source refuses activation authority");
  writeFileSync(unitPath, source);
  const foreign = source.replace(entry, join(root, "foreign/dist/cotal.js"));
  writeFileSync(unitPath, foreign);
  writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(foreign).digest("hex"), installedAt: new Date().toISOString() }));
  assert.deepEqual(await observeDaemonOwnedService(paths), { state: "not-owned", reason: "identity-differs" }, "foreign installation refuses activation authority");
  const stop = new AbortController(); stop.abort();
  assert.equal((await observeDaemonOwnedService(paths, undefined, stop.signal)).state, "unknown", "cancelled observation grants no authority");
  console.log("PASS foreground, changed source, foreign installation and cancellation refuse authority");
} finally {
  process.argv = argv; process.execArgv = execArgv;
  for (const key of Object.keys(process.env)) if (!priorEnv.some(([name]) => name === key)) delete process.env[key];
  for (const [key, value] of priorEnv) process.env[key] = value;
}
