/** Live shipped update against an owned daemon socket and recording native service. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
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
  PATH: `${native}:${(process.env.PATH ?? "").split(":").filter(path => path.startsWith("/")).join(":")}`, HOME: home, USER: "smoke", LOGNAME: "smoke",
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
if (bareCode !== 2 || bareDoc.error?.code !== "DEPENDENCY_UNAVAILABLE" || !bareErr.includes("Signing in to Cotal Cloud. For another host, use cotal login --idp <url>.")) throw new Error(`bare setup service refusal changed: ${bareOut}${bareErr}`);
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
const old = await serveDaemon({ paths, version: "0.0.0", sessionDir: home });
let replacement: ChildProcess | undefined;
const replacements: ChildProcess[] = [];
const calls: string[] = [];
const concurrentRepair = process.argv.includes("--repair-concurrent") || process.argv.includes("--repair-concurrent-late");
const lateConcurrentRepair = process.argv.includes("--repair-concurrent-late");
let launchTwin: (() => void) | undefined;
const repairStartFailure = process.argv.includes("--repair-start-fails");
const repairReloadFailure = process.argv.includes("--repair-reload-fails");
const repairReceiptFailure = process.argv.includes("--repair-receipt-fails");
const invalidProgram = process.argv.includes("--program-directory");
let stops = 0, starts = 0, reloads = 0;
let firstStart: (() => void) | undefined;
const started = new Promise<void>(resolve => { firstStart = resolve; });
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
    if (request.url === "/stop") {
      if (concurrentRepair) {
        if (++stops === 1) { if (lateConcurrentRepair) launchTwin?.(); await new Promise(resolve => setTimeout(resolve, 2000)); }
        else await Promise.race([started.then(() => new Promise(resolve => setTimeout(resolve, 500))), new Promise(resolve => setTimeout(resolve, 15_000))]);
      }
      await old.close();
      if (replacement) { await killAndAwaitExit(replacement, "SIGTERM"); replacement = undefined; }
    } else if (request.url === "/reload") {
      if (repairReloadFailure && ++reloads === 1) { response.writeHead(500).end("owned native reload denied"); return; }
    } else if (request.url === "/start") {
      if (repairStartFailure && ++starts === 1) {
        // The previous installation may have been restored independently while repair ran.
        // Make its recorded launch files available so rollback can be observed succeeding.
        if (!process.argv.includes("--repair-recovery-unavailable")) {
          mkdirSync(dirname(recordedNode), { recursive: true, mode: 0o700 });
          if (recordedNode !== process.execPath) symlinkSync(process.execPath, recordedNode);
          mkdirSync(dirname(foreignEntry), { recursive: true, mode: 0o700 });
          symlinkSync(join(repo, "bin/dist/cotal.js"), foreignEntry);
        }
        response.writeHead(500).end("owned replacement start denied"); return;
      }
      if (repairStartFailure && process.argv.includes("--repair-recovery-unavailable")) { response.writeHead(500).end("previous launch program still absent"); return; }
      if (process.argv.includes("--start-fails")) { response.writeHead(500).end("owned native start denied"); return; }
      const launch = [...(/^ExecStart=(.*)$/m.exec(readFileSync(unitPath, "utf8"))?.[1] ?? "").matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)].map(match => (match[1] ?? match[2]!).replace(/\\([\\"])/g, "$1"));
      if (launch.length < 2) throw new Error("recorded fixture launch is unreadable");
      replacement = spawn(launch[0]!, launch.slice(1), { cwd: root, env, stdio: "ignore" });
      replacements.push(replacement);
      for (let i = 0; ; i++) {
        try { await status(); break; } catch { if (i >= 100) throw new Error("replacement not ready"); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      firstStart?.();
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
const unitStateFile = join(root, "unit-file-state.txt");
writeFileSync(unitStateFile, "enabled\n", { mode: 0o600 });
writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nif(args.join(' ')==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, "config")}`)});process.exit(0)}\nif(args.join(' ')==='--user --no-ask-password --no-pager show cotal-daemon.service --property=UnitFileState --value'){if(${repairReceiptFailure}){const mark=${JSON.stringify(join(root, "shows"))};fs.appendFileSync(mark,'s');if(fs.readFileSync(mark,'utf8').length===2)fs.chmodSync(${JSON.stringify(paths.state)},0o500);}process.stdout.write(fs.readFileSync(${JSON.stringify(unitStateFile)},'utf8'));process.exit(0)}\nif(args.join(' ')==='--user --no-ask-password --no-pager daemon-reload'){${repairReloadFailure ? "fetch('http://127.0.0.1:" + port + "/reload').then(async r=>{if(!r.ok){console.error(await r.text());process.exit(99)}}).catch(()=>process.exit(99));return;" : "process.exit(0)"}}\nconst op=process.argv.at(-2); if(!['stop','start'].includes(op))process.exit(99);fetch('http://127.0.0.1:${port}/'+op).then(async r=>{if(!r.ok){console.error(await r.text());process.exit(99)}}).catch(()=>process.exit(99));\n`, { mode: 0o700 });
const missingProgram = process.argv.includes("--missing-program");
const stoppedMissing = missingProgram && process.argv.includes("--stopped");
const disabledMissing = missingProgram && process.argv.includes("--disabled");
const changedMissing = missingProgram && process.argv.includes("--changed");
const foreign = process.argv.includes("--foreign") || missingProgram;
const foreignEntry = join(root, "another-install/dist/cotal.js");
if (foreign && !missingProgram) {
  mkdirSync(dirname(foreignEntry), { recursive: true, mode: 0o700 });
  writeFileSync(foreignEntry, "// Present, unrelated installation.\n", { mode: 0o600 });
}
const recordedNode = invalidProgram || process.argv.includes("--program-symlink") || (missingProgram && !process.argv.includes("--missing-entry")) ? join(root, "removed-app/cotal-node") : process.execPath;
if (invalidProgram) mkdirSync(recordedNode, { recursive: true, mode: 0o700 });
else if (process.argv.includes("--program-symlink")) {
  mkdirSync(dirname(recordedNode), { recursive: true, mode: 0o700 });
  symlinkSync(process.execPath, recordedNode);
}
const bytes = `[Service]\nExecStart="${recordedNode}" "${foreign ? foreignEntry : join(repo, "bin/dist/cotal.js")}" daemon serve\nRestart=always\n`;
const unitPath = join(root, "config", "systemd", "user", "cotal-daemon.service");
mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
writeFileSync(unitPath, bytes, { mode: 0o600 });
if (!process.argv.includes("--unrecorded")) writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(bytes).digest("hex"), installedAt: new Date().toISOString() }));
if (stoppedMissing) await old.close();
if (disabledMissing) writeFileSync(unitStateFile, "disabled\n", { mode: 0o600 });
if (changedMissing) writeFileSync(unitPath, `${bytes}# changed after install\n`, { mode: 0o600 });
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
  const child = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), ...(process.argv.includes("--setup-foreign") || process.argv.includes("--setup-start-fails") ? ["daemon", "setup", "--space", "absent", "--no-manager", "--wait", "0", "--json"] : ["update", ...(stoppedMissing || process.argv.includes("--self") ? ["--self"] : [])])], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
      replacements.push(replacement);
    })();
  });
  child.stdout.on("data", b => output += String(b)); child.stderr.on("data", b => output += String(b));
  let twinOutput = "";
  let twin: ChildProcess | undefined;
  let twinEnded: Promise<unknown> | undefined;
  launchTwin = () => {
    twin = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "update", ...(lateConcurrentRepair ? [] : ["--self"])], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    twin.stdout!.on("data", b => twinOutput += String(b)); twin.stderr!.on("data", b => twinOutput += String(b));
    twinEnded = new Promise(resolve => twin!.once("exit", resolve));
  };
  if (concurrentRepair && !lateConcurrentRepair) launchTwin();
  const code = await new Promise(resolve => child.once("exit", resolve));
  const twinCode = await twinEnded;
  await transition;
  if (repairReceiptFailure || repairReloadFailure || repairStartFailure || invalidProgram) {
    chmodSync(paths.state, 0o700);
    const after = await status().catch(() => undefined);
    console.log("repair failure observation", JSON.stringify({ code, calls, after, output }));
    const receipt = JSON.parse(readFileSync(join(paths.state, "service-unit.json"), "utf8"));
    if (code === 0 || readFileSync(unitPath, "utf8") !== bytes || receipt.unitSha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("repair failure did not restore recorded source and receipt");
    if (repairReceiptFailure || repairReloadFailure || invalidProgram) {
      if (calls.includes("/stop") || after?.result.version !== "0.0.0" || after.result.update?.restartEvidence?.prepared === true) throw new Error("pre-stop repair failure stopped or fenced the original daemon");
    } else if (calls.join(",") !== "/stop,/start,/start" || (process.argv.includes("--repair-recovery-unavailable") ? after !== undefined || !output.includes("recovery unconfirmed") : !after?.ok)) throw new Error("replacement start failure did not attempt or report the restored recorded service");
    console.log("PASS repair failure preserves publication and recovers service or retains answering predecessor");
  } else if (concurrentRepair) {
    const after = await status().catch(() => undefined);
    console.log("concurrent repair observation", JSON.stringify({ code, twinCode, calls, after, output, twinOutput }));
    if (![code, twinCode].includes(0) || calls.join(",") !== "/stop,/start" || after?.result.version !== version) throw new Error("concurrent repairs stopped the replacement or duplicated native operations");
    console.log("PASS concurrent shipped updates perform one repair and retain answering replacement");
  } else if (generationTimeout) {
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
  const after = stoppedMissing && (disabledMissing || changedMissing) ? undefined : await status();
  if (process.argv.includes("--childless") && !output.includes("no live child")) throw new Error(`R2-10 childless refusal blocked update: ${output}`);
  if (missingProgram) {
    console.log("missing-program update", JSON.stringify({ code, calls, after, output }));
    if (disabledMissing || changedMissing) {
      if (code !== (changedMissing ? 1 : 0) || calls.length || after?.result.version !== (stoppedMissing ? undefined : "0.0.0") || readFileSync(unitPath, "utf8") !== `${bytes}${changedMissing ? "# changed after install\n" : ""}` || !output.includes(changedMissing ? "not the unit this daemon installed" : "service is disabled; missing-program service not repaired or started")) throw new Error("disabled or changed missing-program source was not retained");
      console.log(`PASS ${changedMissing ? "changed" : "disabled"} missing-program service retained without native changes`);
    } else {
      if (code !== 0 || calls.join(",") !== "/stop,/start" || after?.result.version !== version || output.includes("left it stopped") || output.includes("another installation was left running")) throw new Error("missing recorded program was not repaired and verified through shipped update");
      const receipt = JSON.parse(readFileSync(join(paths.state, "service-unit.json"), "utf8"));
      const repaired = readFileSync(unitPath, "utf8");
      if (!repaired.includes(join(repo, "bin/dist/cotal.js")) || repaired.includes("removed-app") || receipt.unitSha256 !== createHash("sha256").update(repaired).digest("hex")) throw new Error("repair did not retain a matching receipt for the current launch coordinates");
      console.log("PASS missing recorded program repaired through shipped update with matching receipt and answering replacement");
    }
  } else if (foreign) {
    console.log("R2-4 foreign update", JSON.stringify({ code, calls, after, output }));
    if (process.argv.includes("--setup-foreign")) {
      if (calls.length || !output.includes("TARGET_NOT_FOUND") || after.result.version !== "0.0.0") throw new Error("R2-4 compatible foreign setup restarted the daemon");
    } else if (calls.length || !output.includes("another-install") || !output.includes("0.0.0")) throw new Error("R2-4 update restarted or failed to identify another installation");
    console.log("PASS R2-4 foreign installation is left running");
    if (!process.argv.includes("--setup-foreign")) {
      const runningForeign = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "update", "--self"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let runningForeignOut = "";
      runningForeign.stdout.on("data", b => runningForeignOut += String(b));
      runningForeign.stderr.on("data", b => runningForeignOut += String(b));
      const runningForeignCode = await new Promise(resolve => runningForeign.once("exit", resolve));
      const stillRunning = await status();
      if (runningForeignCode !== 0 || calls.length || stillRunning.result.version !== "0.0.0" || !runningForeignOut.includes("another installation was left running") || runningForeignOut.includes("left it stopped") || runningForeignOut.includes("No daemon answers")) throw new Error(`foreign running state was misreported by update --self: ${runningForeignOut}`);
      console.log("PASS update --self observes the answering foreign daemon before reporting it left running");
      await old.close();
      calls.length = 0;
      const stoppedForeign = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "update", "--self"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let stoppedForeignOut = "";
      stoppedForeign.stdout.on("data", b => stoppedForeignOut += String(b));
      stoppedForeign.stderr.on("data", b => stoppedForeignOut += String(b));
      const stoppedForeignCode = await new Promise(resolve => stoppedForeign.once("exit", resolve));
      if (stoppedForeignCode !== 0 || calls.length || existsSync(paths.socket) || !stoppedForeignOut.includes(`machine daemon: the background service belongs to another Cotal installation (${join(root, "another-install/dist/cotal.js")}). No daemon answers; this update did not start it.`)) {
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
} finally {
  chmodSync(paths.state, 0o700);
  await old.close();
  for (const daemon of replacements) await killAndAwaitExit(daemon, "SIGTERM");
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
if (changedMissing || invalidProgram) {
  if (!noRuntimeOutput.includes("installed daemon preflight:") || noRuntimeOutput.includes("Built-in connectors")) throw new Error("changed receipt admitted connector reconciliation without runtime discovery");
  console.log("PASS changed receipt refuses without runtime discovery before connector reconciliation");
} else {
  if (noRuntimeOutput.includes("running manager continuity check:") || !noRuntimeOutput.includes("Built-in connectors")) throw new Error("R2-3 no runtime directory blocked stock update continuity");
  console.log("PASS R2-3 update without runtime directory reaches stock reconciliation");
}
