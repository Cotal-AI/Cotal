/** Built CLI updates with the real LaunchAgent adapter and a recording launchctl on Linux.
 * Native macOS job discovery is recorded, not macOS supervisor acceptance. Daemon sockets,
 * peer credentials, kernel lifetime locks and recorded daemon argv execute on the host.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { queryDaemon } from "../daemon/client.js";
import { daemonPaths } from "../daemon/endpoint.js";
import { launchAgentLabel, renderLaunchAgent, xmlText } from "../daemon/install-darwin.js";
import { recordedSourceIdentity } from "../daemon/install-identity.js";
import { serveDaemon } from "../daemon/server.js";

if (process.platform !== "linux") skipSuite("LaunchAgent update recording uses the Linux native endpoint helper");
const root = mkdtempSync(join(tmpdir(), "dlu-"));
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = join(repo, "bin/dist/cotal.js");
const legacy = process.argv.includes("--legacy");
const present = process.argv.includes("--present");
const startFails = process.argv.includes("--start-fails");
const unavailable = process.argv.includes("--unavailable");
const stopped = process.argv.includes("--stopped");
const self = process.argv.includes("--self");
const disabled = process.argv.includes("--disabled");
const home = join(root, "h"), runtime = join(root, "r"), state = join(home, "daemon");
for (const path of [home, runtime, state, join(home, "Library/LaunchAgents"), join(root, ".cotal"), join(root, "native")]) mkdirSync(path, { recursive: true, mode: 0o700 });
const env: NodeJS.ProcessEnv = {
  PATH: (process.env.PATH ?? "").split(":").filter(path => path.startsWith("/")).join(":"), HOME: home, USER: "smoke", LOGNAME: "smoke", COTAL_HOME: home,
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: runtime, TMPDIR: root,
  COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
const paths = daemonPaths(env, home);
const label = launchAgentLabel(undefined);
const plist = join(home, "Library/LaunchAgents", `${label}.plist`);
const receiptPath = join(state, "service-unit.json");
const foreignEntry = join(root, "old/dist/cotal.js");
const oldBootstrap = join(dirname(foreignEntry), "daemon-cwd.js");
const program = present || legacy ? process.execPath : join(root, "old/node");
if (present) {
  mkdirSync(dirname(foreignEntry), { recursive: true, mode: 0o700 });
  writeFileSync(foreignEntry, "// Present foreign installation.\n", { mode: 0o600 });
}
const argv = [program, "--max-semi-space-size=1", foreignEntry, "daemon", "serve"];
const rendered = renderLaunchAgent({ label, argv, searchPath: env.PATH!, workingDirectory: home, logPath: join(state, "daemon.log") });
const source = rendered.text.replace(/<key>ProgramArguments<\/key><array>[\s\S]*?<\/array>/,
  `<key>ProgramArguments</key><array>${(legacy ? argv : [program, "--max-semi-space-size=1", oldBootstrap, home, "daemon", "serve"]).map(value => `<string>${xmlText(value)}</string>`).join("")}</array>`)
  .replace("<key>EnvironmentVariables</key>", `${legacy ? `<key>WorkingDirectory</key><string>${xmlText(home)}</string>\n` : ""}<key>EnvironmentVariables</key>`);
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const receipt = { v: 1, mechanism: "launchd-agent", unit: label, unitPath: plist, unitSha256: sha(source), installedAt: "2026-11-17T00:00:00.000Z" };
const receiptBytes = `${JSON.stringify(receipt)}\n`;
writeFileSync(plist, source, { mode: 0o600 });
writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
const decode = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
const readArgv = (text: string) => [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map(match => decode(match[1]!));
const jobPath = join(root, "job.json");
const setJob = (text?: string) => writeFileSync(jobPath, JSON.stringify(text ? { label, program: readArgv(text)[0], programArguments: readArgv(text), ...(legacy && text === source ? { workingDirectory: home } : {}) } : null), { mode: 0o600 });
setJob(stopped ? undefined : source);
const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
const seed = join(root, "config/cotal/seed");
mkdirSync(seed, { recursive: true, mode: 0o700 });
for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));
const old = await serveDaemon({ paths, version: "0.0.0", sessionDir: home });
if (stopped) await old.close();
const children: ChildProcess[] = [];
const calls: string[][] = [];
const launches: { argv: string[]; sourceSha256: string }[] = [];
let starts = 0;
const control = createServer(async (request, response) => {
  try {
    const args = JSON.parse(new URL(request.url!, "http://fixture").searchParams.get("args")!) as string[];
    calls.push(args);
    let status = 0, stdout = "";
    switch (args[0]) {
      case "print": status = JSON.parse(readFileSync(jobPath, "utf8")) ? 0 : 113; break;
      case "print-disabled": stdout = `disabled services = {\n\t"${label}" => ${disabled}\n}\n`; break;
      case "bootout": await old.close(); setJob(); break;
      case "bootstrap": {
        assert.equal(args[2], plist);
        const text = readFileSync(plist, "utf8");
        const launch = readArgv(text);
        launches.push({ argv: launch, sourceSha256: sha(text) });
        if (startFails && ++starts === 1) {
          if (!unavailable) {
            mkdirSync(dirname(foreignEntry), { recursive: true, mode: 0o700 });
            symlinkSync(entry, foreignEntry);
            symlinkSync(join(repo, "bin/dist/daemon-cwd.js"), oldBootstrap);
            if (program !== process.execPath) symlinkSync(process.execPath, program);
          }
          status = 5; stdout = "owned replacement bootstrap denied"; break;
        }
        if (unavailable) { status = 5; stdout = "previous launch files still absent"; break; }
        const child = spawn(launch[0]!, launch.slice(1), { cwd: legacy ? home : root, env, stdio: "ignore" });
        children.push(child);
        const deadline = Date.now() + 20_000;
        for (;;) {
          try { const reply = await queryDaemon({ paths }); if (reply.ok) break; } catch { /* Bounded startup. */ }
          if (Date.now() >= deadline) throw new Error("recorded bootstrap did not answer");
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        setJob(text); break;
      }
      default: throw new Error(`unexpected native command ${args[0]}`);
    }
    response.end(JSON.stringify({ status, stdout }));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
const registry = createServer((_request, response) => response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } })));
try {
  await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
  env.npm_config_registry = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
  const native = join(root, "native/launchctl.cjs");
  writeFileSync(native, `fetch('http://127.0.0.1:${(control.address() as AddressInfo).port}/?args='+encodeURIComponent(JSON.stringify(process.argv.slice(2))))\n.then(async response=>{if(!response.ok)throw new Error(await response.text());const result=await response.json();process.stdout.write(result.stdout);process.exitCode=result.status;}).catch(error=>{console.error(error);process.exitCode=99});\n`);
  const preload = join(root, "record-darwin.mjs");
  const peerModule = pathToFileURL(join(repo, "packages/seat/dist/peercred.js")).href;
  // Warm the real Linux helper before selecting the Darwin adapter. Keep its kernel-backed
  // credentials and flock. Only the macOS-only host APIs and launchctl subprocess are recorded.
  writeFileSync(preload, `import cp from 'node:child_process';\nimport fs from 'node:fs';\nimport {createRequire,syncBuiltinESMExports} from 'node:module';\ncreateRequire(${JSON.stringify(pathToFileURL(join(repo, "packages/seat/package.json")).href)})('@lydell/node-pty');\nimport {loadNativeHelper} from ${JSON.stringify(peerModule)};\nconst helper=loadNativeHelper();\nhelper.userCacheDir=()=>${JSON.stringify(runtime)};\nhelper.processStartTime=pid=>{try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\\s+/)[19]}catch{return undefined}};\nhelper.launchdJob=()=>JSON.parse(fs.readFileSync(${JSON.stringify(jobPath)},'utf8'));\nconst original=cp.spawnSync;\ncp.spawnSync=(file,args,options)=>{if(file==='/bin/launchctl')return original(process.execPath,[${JSON.stringify(native)},...args],options);if(['systemctl','launchctl','schtasks','loginctl'].includes(file))throw new Error('unrecorded native call');return original(file,args,options)};\nsyncBuiltinESMExports();\nprocess.execArgv=[];\nObject.defineProperty(process,'platform',{value:'darwin'});\n`);
  const identity = recordedSourceIdentity(receipt as import("../daemon/install.js").UnitReceipt, "launchd-agent", [process.execPath, entry, "daemon", "serve"]);
  console.log("identity observation", JSON.stringify({ legacy, present, programExists: existsSync(program), entryExists: existsSync(foreignEntry), identity }));
  const child = spawn(process.execPath, ["--import", preload, entry, "update", ...(self ? ["--self"] : [])], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout!.on("data", chunk => output += String(chunk));
  child.stderr!.on("data", chunk => output += String(chunk));
  const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  const after = await queryDaemon({ paths }).catch(() => undefined);
  const mutations = calls.filter(args => !["print", "print-disabled"].includes(args[0]!));
  console.log("built CLI observation", JSON.stringify({ code, calls, mutations, launches, after, output }));
  if (present) {
    assert.equal(code, 0);
    assert.equal(mutations.length, 0, "present legacy foreign installation must not be rebound");
    assert.equal(identity.missing, false, "a Node flag is not a missing CLI entry");
    assert.equal(identity.installedEntry, foreignEntry);
    assert.equal(after?.ok && after.result.version, stopped ? undefined : "0.0.0");
    assert.match(output, stopped ? /No daemon answers; this update did not start it/ : /another installation was left running/);
    assert.equal(readFileSync(plist, "utf8"), source);
    assert.equal(readFileSync(receiptPath, "utf8"), receiptBytes);
    console.log("PASS present legacy foreign service retains exact source, receipt and answering predecessor without native mutation");
  } else if (disabled) {
    assert.equal(code, 0); assert.equal(mutations.length, 0);
    assert.equal(readFileSync(plist, "utf8"), source);
    assert.equal(readFileSync(receiptPath, "utf8"), receiptBytes);
    assert.match(output, /service is disabled/);
    console.log("PASS disabled missing LaunchAgent remains disabled and unchanged");
  } else if (startFails) {
    assert.notEqual(code, 0);
    assert.equal(readFileSync(plist, "utf8"), source);
    assert.equal(readFileSync(receiptPath, "utf8"), receiptBytes);
    assert.deepEqual(mutations.map(args => args[0]), [...(stopped ? [] : ["bootout"]), "bootstrap", "bootstrap"]);
    assert.equal(launches[1]?.sourceSha256, receipt.unitSha256);
    assert.deepEqual(launches[1]?.argv, readArgv(source));
    if (unavailable) { assert.equal(after, undefined); assert.match(output, /recovery unconfirmed/); }
    else { assert.equal(after?.ok && after.result.version, version); assert.match(output, /original service source and receipt were restored and its daemon answers/); }
    console.log(`PASS failed replacement bootstrap restores original plist/receipt and executes its recorded argv (${unavailable ? "unavailable recovery reported" : "restored daemon answers"})`);
  } else {
    assert.equal(code, 0);
    assert.equal(after?.ok && after.result.version, version);
    assert.equal(launches[0]?.argv.includes(join(repo, "bin/dist/daemon-cwd.js")), true);
    assert.equal(calls.some(args => ["enable", "kickstart"].includes(args[0]!)), false);
    const current = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(current.unitSha256, sha(readFileSync(plist, "utf8")));
    console.log("PASS missing LaunchAgent repaired through built CLI with exact unloaded bootstrap and answering target daemon");
  }
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) await killAndAwaitExit(child, "SIGTERM");
  await old.close();
  await new Promise<void>(resolve => control.close(() => resolve()));
  await new Promise<void>(resolve => registry.close(() => resolve()));
  console.log(`retained fixture ${root}`);
}
