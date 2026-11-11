/** Live shipped update against an owned daemon socket and recording native service. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { serveDaemon } from "../daemon/server.js";
import { daemonStartedByOwnedService } from "../daemon/install.js";
import { daemonPaths } from "../daemon/endpoint.js";

if (process.platform !== "linux") skipSuite("daemon update path: Linux recording supervisor only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "dup-"));
const home = join(root, "home"), runtime = join(root, "run"), native = join(root, "native");
for (const path of [home, runtime, native, join(root, ".cotal"), join(root, "tmp")]) mkdirSync(path, { mode: 0o700 });
const env: NodeJS.ProcessEnv = {
  PATH: `${native}:${process.env.PATH}`, HOME: home, USER: "smoke", LOGNAME: "smoke",
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: runtime, TMPDIR: join(root, "tmp"),
  COTAL_HOME: home, COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
// Setup must validate usage without the dispatcher's operator-global connector reconcile.
const usageConfig = join(root, "usage-config");
const usageEnv: NodeJS.ProcessEnv = { ...env, XDG_CONFIG_HOME: usageConfig };
delete usageEnv.COTAL_SKIP_CONNECTOR_SEED;
const usageNativeLog = join(root, "usage-native.log");
for (const tool of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
  writeFileSync(join(native, tool), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(usageNativeLog)}, 'unexpected native call\\n'); process.exit(99);\n`, { mode: 0o700 });
}
for (const args of [[], ...["bad.space", "a".repeat(65), "bad space"].flatMap(space => [["--space", space], ["--no-manager", "--space", space, "--wait", "0"]])]) {
  const usage = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "setup", ...args, "--json"], { cwd: root, env: usageEnv, stdio: ["ignore", "pipe", "pipe"] });
  let usageOutput = "";
  usage.stdout.on("data", chunk => usageOutput += String(chunk));
  usage.stderr.on("data", chunk => usageOutput += String(chunk));
  const usageCode = await new Promise(resolve => usage.once("exit", resolve));
  if (usageCode !== 1 || !usageOutput.includes("USAGE_INVALID") || existsSync(join(usageConfig, "cotal", "seed")) || existsSync(join(usageConfig, "cotal", "extensions.json")) || existsSync(join(home, "daemon")) || existsSync(join(usageConfig, "systemd")) || existsSync(usageNativeLog)) throw new Error(`setup usage error changed state: ${usageOutput}`);
  console.log(`PASS setup usage error changes no connector or daemon state (${JSON.stringify(args)})`);
}
const paths = daemonPaths(env, home);
if (process.argv.includes("--childless")) {
  const directory = join(home, "daemon", "space.72656675736564");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "manager-refusal.json"), JSON.stringify({ space: "refused", state: "refused", restarts: 0, reason: "sign-in missing" }), { mode: 0o600 });
}
const old = await serveDaemon({ paths, version: "0.0.0", sessionDir: home });
let replacement: ChildProcess | undefined;
const calls: string[] = [];
async function status(): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(paths.socket);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("status timeout")); }, 2000);
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("connect", () => socket.write('{"v":1,"id":"smoke","op":"status"}\n'));
    socket.on("data", chunk => {
      data += String(chunk);
      if (data.includes("\n")) { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(data.split("\n")[0]!)); }
    });
  });
}
const control = createServer(async (request, response) => {
  try {
    calls.push(request.url!);
    if (request.url === "/stop") await old.close();
    else if (request.url === "/start") {
      if (process.argv.includes("--start-fails")) { response.writeHead(500).end("owned native start denied"); return; }
      replacement = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "serve"], { cwd: root, env, stdio: "ignore" });
      for (let i = 0; ; i++) {
        try { await status(); break; } catch { if (i >= 100) throw new Error("replacement not ready"); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else throw new Error("unexpected native operation");
    response.end("ok");
  } catch (error) { response.writeHead(500).end(String(error)); }
});
const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
const seed = join(root, "config/cotal/seed");
mkdirSync(seed, { recursive: true, mode: 0o700 });
for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));
const registry = createServer((_request, response) => response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } })));
await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
const port = (control.address() as AddressInfo).port;
env.npm_config_registry = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nif(process.argv.slice(2).join(' ')==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, "config")}`)});process.exit(0)}\nconst op=process.argv.at(-2); if(!['stop','start'].includes(op))process.exit(99);fetch('http://127.0.0.1:${port}/'+op).then(async r=>{if(!r.ok){console.error(await r.text());process.exit(99)}}).catch(()=>process.exit(99));\n`, { mode: 0o700 });
const foreign = process.argv.includes("--foreign");
const bytes = `[Service]\nExecStart="${process.execPath}" "${foreign ? join(root, "another-install/dist/cotal.js") : join(repo, "bin/dist/cotal.js")}" daemon serve\nRestart=always\n`;
const unitPath = join(root, "config", "systemd", "user", "cotal-daemon.service");
mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
writeFileSync(unitPath, bytes, { mode: 0o600 });
if (!process.argv.includes("--unrecorded")) writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(bytes).digest("hex"), installedAt: new Date().toISOString() }));
if (process.argv.includes("--provenance")) {
  const argv = process.argv, execArgv = process.execArgv;
  const marker = process.env.COTAL_DAEMON_NATIVE_SERVICE;
  const path = process.env.PATH;
  try {
    process.env.PATH = env.PATH;
    process.argv = [process.execPath, join(repo, "bin/dist/cotal.js")];
    process.execArgv = [];
    delete process.env.COTAL_DAEMON_NATIVE_SERVICE;
    if ((daemonStartedByOwnedService(paths).state === "owned")) throw new Error("foreground accepted as native");
    process.env.COTAL_DAEMON_NATIVE_SERVICE = "1";
    if ((daemonStartedByOwnedService(paths).state === "owned")) throw new Error("unmarked source accepted as native");
    const marked = bytes.replace("[Service]", "[Service]\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1");
    writeFileSync(unitPath, marked, { mode: 0o600 });
    if (!process.argv.includes("--unrecorded")) writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(marked).digest("hex"), installedAt: new Date().toISOString() }));
    if (!(daemonStartedByOwnedService(paths).state === "owned")) throw new Error("verified native source refused");
    console.log("PASS native marker requires verified same-install source");
  } finally {
    process.argv = argv; process.execArgv = execArgv;
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    if (marker === undefined) delete process.env.COTAL_DAEMON_NATIVE_SERVICE; else process.env.COTAL_DAEMON_NATIVE_SERVICE = marker;
  }
}
try {
  const generationRace = process.argv.includes("--generation-race");
  const generationTimeout = process.argv.includes("--generation-timeout");
  if (generationRace || generationTimeout) {
    env.COTAL_UPDATE_TARGET_VERSION = version;
    env.COTAL_UPDATE_PARENT = String(process.pid);
  }
  const child = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), ...(process.argv.includes("--setup-foreign") || process.argv.includes("--setup-start-fails") ? ["daemon", "setup", "--space", "absent", "--no-manager", "--wait", "0", "--json"] : ["update"])], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let transition: Promise<void> | undefined;
  child.stdout.on("data", chunk => {
    if (generationRace && String(chunk).includes("waiting up to 120s") && !transition) transition = (async () => {
      if (output.includes("Built-in connectors")) throw new Error("connector writes preceded generation readiness");
      await old.close();
      await new Promise(resolve => setTimeout(resolve, 1500));
      const replacementEnv = { ...env };
      delete replacementEnv.COTAL_UPDATE_TARGET_VERSION;
      delete replacementEnv.COTAL_UPDATE_PARENT;
      replacement = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "serve"], { cwd: root, env: replacementEnv, stdio: "ignore" });
    })();
  });
  child.stdout.on("data", b => output += String(b)); child.stderr.on("data", b => output += String(b));
  const code = await new Promise(resolve => child.once("exit", resolve));
  await transition;
  if (generationTimeout) {
    if (code !== 1 || calls.length || output.includes("Built-in connectors") || !output.includes("did not become ready within 120s") || !output.includes("then run cotal update again")) throw new Error(`generation timeout did not refuse before writes with recovery: ${output}`);
    console.log("PASS bounded generation wait refuses before connector writes and names recovery");
  } else if (generationRace) {
    const after = await status();
    if (code !== 0 || calls.length || !transition || after.result.version !== version || !output.includes("Built-in connectors")) throw new Error(`replacement reconcile raced activation: ${JSON.stringify({ code, calls, output })}`);
    console.log("PASS replacement reconcile waits through endpoint loss without a second restart");
  } else if (process.argv.includes("--unrecorded")) {
    const after = await status();
    console.log("unrecorded daemon update", JSON.stringify({ code, calls, after, output }));
    if (code !== 0 || calls.length || after.result.version !== "0.0.0" || !output.includes("runs Cotal 0.0.0; no recorded user service, left running")) throw new Error("unrecorded daemon blocked update or was restarted");
    console.log("PASS unrecorded daemon update finishes without native calls");
  } else if (process.argv.includes("--start-fails")) {
    console.log("R2-12 failed native start", JSON.stringify({ code, calls, output }));
    if (code === 0 || calls.join(",") !== "/stop,/start" || !output.includes("owned native start denied") || !output.includes("cotal daemon start")) throw new Error("R2-12 native failure or recovery command missing");
    console.log("PASS R2-12 native error and daemon start recovery retained");
  } else {
  const after = await status();
  if (process.argv.includes("--childless") && !output.includes("no live child")) throw new Error(`R2-10 childless refusal blocked update: ${output}`);
  if (foreign) {
    console.log("R2-4 foreign update", JSON.stringify({ code, calls, after, output }));
    if (process.argv.includes("--setup-foreign")) {
      if (calls.length || !output.includes("TARGET_NOT_FOUND") || after.result.version !== "0.0.0") throw new Error("R2-4 compatible foreign setup restarted the daemon");
    } else if (calls.length || !output.includes("another-install") || !output.includes("0.0.0")) throw new Error("R2-4 update restarted or failed to identify another installation");
    console.log("PASS R2-4 foreign installation is left running");
  } else {
    if (code !== 0 || !calls.includes("/stop") || !calls.includes("/start") || after.result.version === "0.0.0") throw new Error(`R2-5 empty daemon not reloaded: ${JSON.stringify({ code, calls, after, output })}`);
    console.log("PASS R2-5 empty default daemon reload through shipped update");
  }
  }
} finally {
  await old.close();
  if (replacement) await killAndAwaitExit(replacement, "SIGTERM");
  await Promise.all([control, registry].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  if (existsSync(paths.socket) || control.listening || registry.listening) throw new Error("owned update fixture did not close");
  console.log("PASS owned daemon and loopback listeners closed");
}
const noRuntime: NodeJS.ProcessEnv = { ...env, npm_config_offline: "true" };
delete noRuntime.XDG_RUNTIME_DIR;
const noDaemon = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "update"], { cwd: root, env: noRuntime, stdio: ["ignore", "pipe", "pipe"] });
let noRuntimeOutput = "";
noDaemon.stdout.on("data", chunk => noRuntimeOutput += String(chunk));
noDaemon.stderr.on("data", chunk => noRuntimeOutput += String(chunk));
await new Promise(resolve => noDaemon.once("exit", resolve));
console.log("R2-3 output", noRuntimeOutput);
if (noRuntimeOutput.includes("running manager continuity check:") || !noRuntimeOutput.includes("Built-in connectors")) throw new Error("R2-3 no runtime directory blocked stock update continuity");
console.log("PASS R2-3 update without runtime directory reaches stock reconciliation");
