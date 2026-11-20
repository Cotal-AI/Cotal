/** Live shipped update against an owned daemon socket and recording native service. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createSocketServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { serveDaemon } from "../daemon/server.js";
import { daemonStartedByOwnedService } from "../daemon/install.js";
import { daemonPaths } from "../daemon/endpoint.js";
import { generationOf, holdLifetime } from "../daemon/lifetime.js";

if (process.platform !== "linux") skipSuite("daemon update path: Linux recording supervisor only");
if (process.argv.includes("--fixture-occupied")) {
  const paths = daemonPaths(process.env, process.env.COTAL_HOME);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  mkdirSync(paths.dir!, { recursive: true, mode: 0o700 });
  const lifetime = holdLifetime(paths.lock);
  const daemon = createSocketServer(peer => {
    peer.setEncoding("utf8");
    let buffer = "";
    peer.on("data", chunk => {
      buffer += chunk;
      for (let newline; (newline = buffer.indexOf("\n")) !== -1;) {
        const { id, v, op } = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const result = { pid: process.pid, version: "0.0.0", managers: [] };
        const reply = op === "managers-prepare-restart" ? { ok: false, error: { code: "SEATS_ACTIVE", message: "hosted Manager holds 1 active seat", remedy: "stop the seat before repair" } } : { ok: true, result };
        peer.write(JSON.stringify({ id, v, ...reply }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(paths.socket, resolve));
  const { chmodSync } = await import("node:fs");
  chmodSync(paths.socket, 0o600);
  lifetime.publishing(generationOf(paths.socket));
  process.once("SIGTERM", () => daemon.close(() => lifetime.release()));
  process.stdout.write("ready\n");
  await new Promise<void>(resolve => process.once("beforeExit", resolve));
  process.exit(0);
}
if (process.argv.includes("--fixture-old")) {
  const daemon = await serveDaemon({ paths: daemonPaths(process.env, process.env.COTAL_HOME), version: "0.0.0", sessionDir: process.env.COTAL_HOME! });
  process.once("SIGTERM", () => { void daemon.close(); });
  process.stdout.write("ready\n");
  await new Promise<void>(resolve => process.once("beforeExit", resolve));
  process.exit(0);
}
const repair = process.argv.includes("--missing-program");
const refusal = process.argv.find(arg => ["--modified-unit", "--foreign-native", "--unreadable-native", "--occupied"].includes(arg));
if (process.argv.length === 2) {
  const regression = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--missing-program", "--stopped", "--update-first"], { stdio: "inherit", timeout: 180_000 });
  if (regression.status !== 0) throw new Error(`stopped missing-program regression failed: ${regression.error ?? regression.status ?? regression.signal}`);
}
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "dup-"));
const home = join(root, "home"), runtime = join(root, "run"), native = join(root, "native");
for (const path of [home, runtime, native, join(root, ".cotal"), join(root, "tmp")]) mkdirSync(path, { mode: 0o700 });
const env: NodeJS.ProcessEnv = {
  PATH: [native, ...(process.env.PATH ?? "").split(":").filter(isAbsolute)].join(":"), HOME: home, USER: "smoke", LOGNAME: "smoke",
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
// Bare setup is supported: it selects Cloud before checking the native service dependency.
const bareConfig = join(root, "bare-config");
const bareNative = join(root, "bare-native");
mkdirSync(bareNative, { mode: 0o700 });
writeFileSync(join(bareNative, "systemctl"), `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '--user show-environment') require('node:fs').appendFileSync(${JSON.stringify(usageNativeLog)}, 'unexpected native call\\n'); process.exit(99);\n`, { mode: 0o700 });
const bare = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "setup", "--json"], {
  cwd: root, env: { ...usageEnv, PATH: `${bareNative}:${env.PATH}`, XDG_CONFIG_HOME: bareConfig, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "absent-bus")}` }, stdio: ["ignore", "pipe", "pipe"],
});
let bareOut = "", bareErr = "";
bare.stdout.on("data", chunk => bareOut += String(chunk));
bare.stderr.on("data", chunk => bareErr += String(chunk));
const bareCode = await new Promise(resolve => bare.once("exit", resolve));
const bareDoc = JSON.parse(bareOut);
if (bareCode !== 2 || bareDoc.error?.code !== "DEPENDENCY_UNAVAILABLE" || !bareErr.includes("Signing in to Cotal Cloud. For another host, use `cotal login --idp <url>`.")) throw new Error(`bare setup service refusal changed: ${bareOut}${bareErr}`);
if (existsSync(join(bareConfig, "cotal", "seed")) || existsSync(join(bareConfig, "cotal", "extensions.json")) || existsSync(join(home, "daemon")) || existsSync(join(bareConfig, "systemd")) || existsSync(usageNativeLog)) throw new Error("bare setup service refusal wrote connector, daemon or native service state");
console.log("PASS bare setup selects Cloud then refuses unavailable service without writing state");
for (const args of ["bad.space", "a".repeat(65), "bad space"].flatMap(space => [["--space", space], ["--no-manager", "--space", space, "--wait", "0"]])) {
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
const fixtureOld = repair ? spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), refusal === "--occupied" ? "--fixture-occupied" : "--fixture-old"], { cwd: root, env, stdio: ["ignore", "pipe", "inherit"] }) : undefined;
if (fixtureOld) await new Promise<void>((resolve, reject) => {
  fixtureOld.stdout!.once("data", () => resolve());
  fixtureOld.once("exit", code => reject(new Error(`old daemon fixture exited with ${code}`)));
});
const old = fixtureOld ? { close: async () => { if (fixtureOld.exitCode === null && fixtureOld.signalCode === null) await killAndAwaitExit(fixtureOld, "SIGTERM"); } } : await serveDaemon({ paths, version: "0.0.0", sessionDir: home });
let replacement: ChildProcess | undefined;
const oldPid = fixtureOld?.pid ?? process.pid;
let mainPid = oldPid;
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
    if (request.url === "/stop") { await old.close(); mainPid = 0; }
    else if (request.url === "/start") {
      if (process.argv.includes("--start-fails")) { response.writeHead(500).end("owned native start denied"); return; }
      replacement = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "serve"], { cwd: root, env, stdio: "ignore" });
      mainPid = replacement.pid!;
      for (let i = 0; ; i++) {
        try { await status(); break; } catch { if (i >= 100) throw new Error("replacement not ready"); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else if (request.url === "/show") {
      calls.pop();
      response.end(String(refusal === "--foreign-native" ? process.pid : mainPid)); return;
    } else if (request.url !== "/daemon-reload") throw new Error("unexpected native operation");
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
const unitStateFile = join(root, "unit-file-state.txt");
writeFileSync(unitStateFile, "enabled\n", { mode: 0o600 });
const foreign = process.argv.includes("--foreign");
const otherEntry = join(root, "another-install/dist/cotal.js");
if (foreign && !repair) { mkdirSync(dirname(otherEntry), { recursive: true }); writeFileSync(otherEntry, "// another installation\n"); }
const bytes = `[Service]\n${repair ? "Environment=COTAL_DAEMON_NATIVE_SERVICE=1\n" : ""}ExecStart="${process.execPath}" "${foreign || repair ? otherEntry : join(repo, "bin/dist/cotal.js")}" daemon serve\nRestart=always\n`;
const unitPath = join(root, "config", "systemd", "user", "cotal-daemon.service");
writeFileSync(join(native, "systemctl"), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
const enablement=()=>fs.readFileSync(${JSON.stringify(unitStateFile)},'utf8').trim();
const get=(op)=>fetch('http://127.0.0.1:${port}/'+op);
if(args.join(' ')==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, "config")}`)});process.exit(0)}
if(args.join(' ')==='--user --no-ask-password --no-pager show cotal-daemon.service --property=UnitFileState --value'){console.log(enablement());process.exit(0)}
if(args.includes('show') && args.includes('cotal-daemon.service')) {
  get('show').then(r=>r.text()).then(pid => {
    const live = pid !== '0';
    const fields={Id:'cotal-daemon.service',LoadState:'loaded',FragmentPath:${JSON.stringify(unitPath)},DropInPaths:'',NeedDaemonReload:'no',Transient:'no',MainPID:pid,ControlPID:'0',ActiveState:live?'active':'inactive',SubState:live?'running':'dead',UnitFileState:enablement(),InvocationID:live?'1'.repeat(32):'',WorkingDirectory:'',Job:'0',ExecStop:'',ExecStopPost:''};
    for (const flag of args.filter(x=>x.startsWith('--property='))) { const key=flag.slice(11); if (!(key in fields)) process.exit(99); console.log(key+'='+fields[key]); }
  }).catch(()=>process.exit(99));
} else {
  const op=args.includes('daemon-reload')?'daemon-reload':args.at(-2);
  if(!['stop','start','daemon-reload'].includes(op))process.exit(99);
  get(op).then(async r=>{if(!r.ok){console.error(await r.text());process.exit(99)}}).catch(()=>process.exit(99));
}
`, { mode: 0o700 });
writeFileSync(join(native, "busctl"), `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.slice(-3).join(' ')!=='ExecStartEx ExecStopEx ExecStopPostEx')process.exit(99);
if(${JSON.stringify(refusal === "--unreadable-native")})process.exit(88);
const args=[.../^ExecStart=(.*)$/m.exec(fs.readFileSync(${JSON.stringify(unitPath)},'utf8'))[1].matchAll(/"([^"]+)"|([^\\s"]+)/g)].map(m=>m[1]??m[2]);
fetch('http://127.0.0.1:${port}/show').then(r=>r.text()).then(pid=>{
  for (const data of [[[args[0],args,[],0,0,0,0,Number(pid),0,0]],[],[]]) console.log(JSON.stringify({type:'a(sasasttttuii)',data}));
}).catch(()=>process.exit(99));
`, { mode: 0o700 });
mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
writeFileSync(unitPath, bytes, { mode: 0o600 });
if (!process.argv.includes("--unrecorded")) writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(bytes).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
if (refusal === "--modified-unit") writeFileSync(unitPath, bytes + "# edited after installation\n");
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
  if (repair) {
    const updateFirst = process.argv.includes("--update-first");
    const stopped = process.argv.includes("--stopped");
    const disabled = process.argv.includes("--disabled");
    if (disabled) writeFileSync(unitStateFile, "disabled\n");
    if (stopped) { await old.close(); mainPid = 0; }
    const run = async (args: string[]) => {
      const child = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", b => stdout += String(b)); child.stderr.on("data", b => stderr += String(b));
      const code = await new Promise(resolve => child.once("close", resolve));
      return { code, stdout, stderr };
    };
    const update = ["update", "--self"], readStatus = ["daemon", "status", "--json"];
    const originalSource = readFileSync(unitPath, "utf8");
    const originalReceipt = readFileSync(join(paths.state, "service-unit.json"), "utf8");
    const first = await run(updateFirst ? update : readStatus);
    const second = await run(updateFirst ? readStatus : update);
    const after = await run(readStatus);
    const nativeCalls = [...calls];
    const expectedCalls = [...(stopped ? [] : ["/stop"]), "/daemon-reload", ...(disabled ? [] : ["/start"])];
    const unit = readFileSync(unitPath, "utf8");
    const receipt = JSON.parse(readFileSync(join(paths.state, "service-unit.json"), "utf8"));
    console.log("missing program", JSON.stringify({ updateFirst, stopped, disabled, first, second, after, nativeCalls }));
    if (refusal) {
      const report = JSON.parse(after.stdout);
      const expectedCode = refusal === "--unreadable-native" ? "TARGET_UNAVAILABLE" : refusal === "--occupied" ? "LIFECYCLE_BLOCKED" : "CONFLICT";
      if (first.code !== 2 || second.code !== 2 || after.code !== 2 || report.error?.code !== expectedCode || !report.error.message.includes("program is missing") || !report.error.remedy.includes("cotal daemon install") || calls.length || unit !== originalSource || readFileSync(join(paths.state, "service-unit.json"), "utf8") !== originalReceipt || (await status()).result.pid !== oldPid) throw new Error(`unsafe repair refusal: ${refusal}`);
      console.log(`PASS missing program ${refusal} refused without altering the unit, receipt or old daemon`);
    } else {
      if (unit.includes(otherEntry) || !unit.includes(join(repo, "bin/dist/cotal.js")) || receipt.unitSha256 !== createHash("sha256").update(unit).digest("hex") || JSON.stringify(nativeCalls) !== JSON.stringify(expectedCalls) || /another installation|left it stopped/i.test(first.stdout + first.stderr + second.stdout + second.stderr)) throw new Error("the recorded missing program was not repaired safely");
      const statusDoc = JSON.parse(after.stdout);
      if (disabled ? after.code !== 2 || statusDoc.error?.code !== "TARGET_UNAVAILABLE" : first.code !== 0 || second.code !== 0 || after.code !== 0 || statusDoc.result?.version !== version || statusDoc.result?.pid === oldPid) throw new Error("the repaired service's observed state did not match its enablement");
      console.log("PASS repaired an owned missing program and checked its native start policy");
    }
  } else {
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
    if (code !== 1 || calls.length || output.includes("Built-in connectors") || !output.includes("did not become ready within 120s") || !output.replaceAll("`", "").includes("then run cotal update again")) throw new Error(`generation timeout did not refuse before writes with recovery: ${output}`);
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
    const ownerReport = `machine daemon: the background service belongs to another Cotal installation (${otherEntry}). This update did not start or stop it.`;
    if (process.argv.includes("--setup-foreign")) {
      if (calls.length || !output.includes("TARGET_NOT_FOUND") || after.result.version !== "0.0.0") throw new Error("R2-4 compatible foreign setup restarted the daemon");
    } else if (calls.length || !output.includes(`${ownerReport} The daemon is running Cotal 0.0.0.`)) throw new Error("R2-4 update restarted or failed to identify the running foreign installation");
    console.log("PASS R2-4 foreign installation is left running");
    if (!process.argv.includes("--setup-foreign")) {
      await old.close();
      calls.length = 0;
      const stoppedForeign = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "update", "--self"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let stoppedForeignOut = "";
      stoppedForeign.stdout.on("data", b => stoppedForeignOut += String(b));
      stoppedForeign.stderr.on("data", b => stoppedForeignOut += String(b));
      const stoppedForeignCode = await new Promise(resolve => stoppedForeign.once("exit", resolve));
      if (stoppedForeignCode !== 0 || calls.length || existsSync(paths.socket) || !stoppedForeignOut.split("\n").includes(ownerReport)) {
        throw new Error(`stopped foreign service was started or not reported: ${JSON.stringify({ stoppedForeignCode, calls, stoppedForeignOut })}`);
      }
      console.log("PASS stopped foreign installation is left stopped and named by update --self");
    }
  } else {
    if (code !== 0 || !calls.includes("/stop") || !calls.includes("/start") || after.result.version === "0.0.0") throw new Error(`R2-5 empty daemon not reloaded: ${JSON.stringify({ code, calls, after, output })}`);
    console.log("PASS R2-5 empty default daemon reload through shipped update");
    if (!process.argv.includes("--childless")) {
      if (replacement) { await killAndAwaitExit(replacement, "SIGTERM"); replacement = undefined; }
      calls.length = 0;
      const stoppedSelf = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "update", "--self"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let stoppedOutput = "";
      stoppedSelf.stdout.on("data", b => stoppedOutput += String(b));
      stoppedSelf.stderr.on("data", b => stoppedOutput += String(b));
      const stoppedCode = await new Promise(resolve => stoppedSelf.once("exit", resolve));
      const repaired = await status();
      if (stoppedCode !== 0 || calls.join(",") !== "/start" || repaired.result.version !== version) {
        throw new Error(`stopped owned daemon was not started by update --self: ${JSON.stringify({ stoppedCode, calls, repaired, stoppedOutput })}`);
      }
      console.log("PASS stopped owned daemon started and verified ready by update --self");
      if (replacement) { await killAndAwaitExit(replacement, "SIGTERM"); replacement = undefined; }
      calls.length = 0;
      for (const nonEnabledState of ["disabled", "static"]) {
        writeFileSync(unitStateFile, `${nonEnabledState}\n`, { mode: 0o600 });
        const disabledSelf = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "update", "--self"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let disabledOutput = "";
        disabledSelf.stdout.on("data", b => disabledOutput += String(b));
        disabledSelf.stderr.on("data", b => disabledOutput += String(b));
        const disabledCode = await new Promise(resolve => disabledSelf.once("exit", resolve));
        if (disabledCode !== 0 || calls.length || existsSync(paths.socket) || !disabledOutput.includes(`cotal-daemon.service: service is ${nonEnabledState}; not started`)) {
          throw new Error(`${nonEnabledState} owned daemon was started or not reported by update --self: ${JSON.stringify({ disabledCode, calls, disabledOutput })}`);
        }
        console.log(`PASS ${nonEnabledState} owned daemon left stopped and reported by update --self`);
      }
    }
  }
  }
  }
} finally {
  await old.close();
  if (replacement) await killAndAwaitExit(replacement, "SIGTERM");
  await Promise.all([control, registry].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  if (existsSync(paths.socket) || control.listening || registry.listening) throw new Error("owned update fixture did not close");
  console.log("PASS owned daemon and loopback listeners closed");
}
if (!repair) {
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
}
