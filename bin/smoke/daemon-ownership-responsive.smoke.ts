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
import { queryDaemon } from "../daemon/client.js";

if (process.platform !== "linux") skipSuite("daemon ownership responsiveness: recording Linux supervisor required");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "dor-"));
const home = join(root, "home"), config = join(root, "config"), runtime = join(root, "rt"), native = join(root, "native");
for (const directory of [home, config, runtime, native]) mkdirSync(directory, { mode: 0o700 });
const env = { ...process.env, HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: runtime, PATH: `${native}:${process.env.PATH}`, COTAL_DAEMON_NATIVE_SERVICE: "1", COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
const paths = daemonPaths(env, home);
mkdirSync(paths.state, { recursive: true, mode: 0o700 });
const entry = join(repo, "bin/dist/cotal.js");
const unitPath = join(config, "systemd/user/cotal-daemon.service");
mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
const source = `[Service]\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${process.execPath}" "${entry}" daemon serve\nRestart=always\n`;
writeFileSync(unitPath, source, { mode: 0o600 });
writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
const marker = join(root, "native-started"), finished = join(root, "native-finished"), count = join(root, "calls");
writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.slice(2).join(' ')!=='--user show-environment')process.exit(99);fs.appendFileSync(${JSON.stringify(count)},'query\\n');fs.writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(finished)},'finished');console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});},1200);\n`, { mode: 0o700 });
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
  await delay(1600);
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 1, "native ownership observation runs once");
  console.log("PASS exact native ownership observation runs once");
} finally {
  await killAndAwaitExit(child, "SIGTERM");
  console.log(`Retained ownership responsiveness fixture: ${root}`);
}

// Exercise the compiled observer too: a responsive daemon with authority always false
// would pass the request check but break native generation activation.
const { observeDaemonOwnedService } = await import(pathToFileURL(join(repo, "bin/dist/daemon/install.js")).href);
const priorEnv = { ...process.env }, argv = process.argv, execArgv = process.execArgv;
try {
  Object.assign(process.env, env);
  process.argv = [process.execPath, entry]; process.execArgv = [];
  assert.equal(await observeDaemonOwnedService(paths), true, "matching native source retains activation authority");
  console.log("PASS asynchronous observation verifies matching exact native source");
  delete process.env.COTAL_DAEMON_NATIVE_SERVICE;
  assert.equal(await observeDaemonOwnedService(paths), false, "foreground process is not a native service");
  process.env.COTAL_DAEMON_NATIVE_SERVICE = "1";
  writeFileSync(unitPath, source + "# changed\n");
  assert.equal(await observeDaemonOwnedService(paths), false, "changed source refuses activation authority");
  writeFileSync(unitPath, source);
  process.argv = [process.execPath, join(root, "foreign/dist/cotal.js")];
  assert.equal(await observeDaemonOwnedService(paths), false, "foreign installation refuses activation authority");
  const stop = new AbortController(); stop.abort();
  assert.equal(await observeDaemonOwnedService(paths, undefined, stop.signal), false, "cancelled observation grants no authority");
  console.log("PASS foreground, changed source, foreign installation and cancellation refuse authority");
} finally {
  process.argv = argv; process.execArgv = execArgv;
  for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
  Object.assign(process.env, priorEnv);
}
