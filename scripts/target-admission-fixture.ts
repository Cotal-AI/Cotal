import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { prepareUpdateParticipant } from "../implementations/auth/smoke/update-participant.fixture.js";
import { candidatePairRegistry } from "./candidate-pair-registry.mjs";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
interface Context { env: NodeJS.ProcessEnv; project: string; pkg: string; root: string; config: string; cotalHome: string; prefix: string; cli: string; output: string; options: Record<string, any>; report: Record<string, any>; call(label: string, file: string, argv: string[], timeout?: number): Promise<any>; cotal(label: string, argv: string[], timeout?: number): Promise<any>; check(name: string, passed: boolean, observed: unknown): void }

/** Real participant and installed Manager composition for the five staged-admission coordinates. */
export async function prepareTargetAdmission(context: Context) {
  const { env, root, config, cotalHome, pkg, cli, options, report, call, cotal, check, output } = context;
  const mode = options["target-admission"] as string;
  assert(["foreign-preserving", "offline", "manager-unknown", "consent-stop", "consent-declined"].includes(mode));
  assert(["linux", "darwin"].includes(process.platform));
  const controls = { pauseBroker() { throw new Error("broker control not initialized"); }, resumeBroker() { throw new Error("broker control not initialized"); } };
  const priorEnv = { ...process.env };
  const closeParticipant = await prepareUpdateParticipant({ ...context, admissionControls: controls });
  const space = report.participant.space as string;
  const evidence: Record<string, any> = { mode, space, observations: [], oldSets: [], commands: [] };
  report.targetAdmission = evidence;
  const preparationRegistry = env.npm_config_registry;
  Object.assign(process.env, env);
  let foreign: ReturnType<typeof spawn> | undefined, oldRegistry: Awaited<ReturnType<typeof candidatePairRegistry>> | undefined;
  let managerPid: number | undefined, brokerPaused = false, managerPaused = false;
  const owned = new Map<number, string>();
  try {
  const workspace = await import(pathToFileURL(join(pkg, "node_modules/@cotal-ai/workspace/dist/index.js")).href);
  const startToken = (pid: number) => workspace.processStartToken(pid) as string | undefined;
  const pin = (pid: number) => { const start = startToken(pid); assert(start, `native process identity unavailable for ${pid}`); owned.set(pid, start); return { pid, start }; };
  const alive = (identity: { pid: number; start: string }) => startToken(identity.pid) === identity.start;
  const ok = (value: any, label: string) => { assert.equal(value.exit, 0, `${label}: ${value.stdout}${value.stderr}`); return value; };
  const record = (label: string, value: any) => { evidence.observations.push({ label, at: new Date().toISOString(), value }); return value; };
  let serviceEntry = cli;
  const oldVersionFiles = () => {
    const files: string[] = [];
    const shared = join(config, "seed/store", report.source);
    if (existsSync(shared)) files.push(shared);
    const installs = join(config, "installs");
    if (existsSync(installs)) for (const id of readdirSync(installs)) {
      const set = join(installs, id, "sets", report.source);
      if (existsSync(set)) files.push(set);
    }
    return files;
  };
  function census(paths: string[]) {
    const rows: { path: string; sha256: string }[] = [];
    const visit = (path: string) => { for (const name of readdirSync(path, { withFileTypes: true })) { const child = join(path, name.name); if (name.isDirectory()) visit(child); else if (name.isFile() && !child.includes(`${process.platform === "win32" ? "\\" : "/"}holders/`)) rows.push({ path: child, sha256: hash(readFileSync(child)) }); } };
    for (const path of paths) visit(path);
    assert(rows.length > 0, "the loaded connector generation must contain real files");
    return rows;
  }
  async function stop(child: ReturnType<typeof spawn>) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGCONT"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    await done; clearTimeout(timer);
  }
  const client = await import(pathToFileURL(join(pkg, "dist/daemon/client.js")).href);
  const endpoint = await import(pathToFileURL(join(pkg, "dist/daemon/endpoint.js")).href);
  const paths = endpoint.daemonPaths(env, cotalHome);
  const query = async () => { const reply = await client.queryDaemon({ paths }); assert(reply.ok, "real daemon must answer"); return reply.result; };
  const managerRow = async () => { const status = await query(); const row = status.managers?.find((value: any) => value.space === space); assert(row?.pid && row.instanceId, "actual retained Manager identity required"); return { status, row }; };
  const spawnArgs = (name: string, instance: string) => ["spawn", "--agent", "admission-standin", "--on", instance, "--name", name, "--detach", "--no-events", "--space", space];
  const ps = async (label: string, instance: string) => JSON.parse(ok(await cotal(label, ["ps", "--on", instance, "--space", space, "--json"]), label).stdout).result;
  const close = Object.assign(async () => {
    if (managerPaused && managerPid && startToken(managerPid) === owned.get(managerPid)) process.kill(managerPid, "SIGCONT");
    if (brokerPaused) controls.resumeBroker();
    try {
      // The original foreign fence belongs to a dead updater. Stopping this owned daemon closes
      // its own child relationship, never clears the fence by impersonating that updater.
      if (foreign) await stop(foreign);
      else try { await client.managerViaDaemon({ paths }, { op: "managers-stop" }); } catch (error) { evidence.teardownRefusal = String(error); throw error; }
    } finally {
      if (oldRegistry) await oldRegistry.close();
      await closeParticipant();
      for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
      Object.assign(process.env, priorEnv);
      evidence.remaining = [...owned].filter(([pid, start]) => startToken(pid) === start);
      // The native service is removed by matrixCell's existing receipt-bound shutdown.
      evidence.remaining = evidence.remaining.filter(([pid]: [number, string]) => pid !== evidence.before?.daemon.pid && pid !== evidence.after?.daemon.pid);
      assert.equal(evidence.remaining.length, 0, "owned admission child processes must stop before report");
    }
  }, {
    customDaemon: mode === "foreign-preserving",
    async beforeUpdate() {
      if (mode === "foreign-preserving") {
        assert(options["admission-legacy-candidate"] && options["admission-legacy-next"], "foreign preserving requires immutable legacy public-updater artifacts");
        oldRegistry = await candidatePairRegistry(options["admission-legacy-candidate"], options["admission-legacy-next"]);
        const foreignPrefix = join(root, "foreign-prefix"); mkdirSync(foreignPrefix, { mode: 0o700 });
        evidence.foreignPrefix = foreignPrefix;
        const npm = process.platform === "win32" ? "npm.cmd" : "npm";
        const saved = env.npm_config_registry;
        env.npm_config_registry = oldRegistry.url;
        try { ok(await call("install exact legacy foreign service", npm, ["install", "-g", "--prefix", foreignPrefix, `cotal-ai@${oldRegistry.identity.sourceVersion}`, "--ignore-scripts", "--no-audit", "--no-fund"]), "legacy foreign install"); }
        finally { env.npm_config_registry = saved; }
        serviceEntry = join(foreignPrefix, "lib/node_modules/cotal-ai/dist/cotal.js");
        ok(await call("seed actual foreign installed service", process.execPath, [serviceEntry, "ext", "seed", "--repair"]), "foreign seed");
        foreign = spawn(process.execPath, [serviceEntry, "daemon", "serve"], { cwd: context.project, env: { ...env, npm_config_prefix: foreignPrefix }, stdio: ["ignore", "pipe", "pipe"] });
        let foreignLogs = ""; foreign.stdout!.on("data", bytes => { foreignLogs += bytes; evidence.foreignLogs = foreignLogs; }); foreign.stderr!.on("data", bytes => { foreignLogs += bytes; evidence.foreignLogs = foreignLogs; });
        foreign.once("spawn", () => pin(foreign!.pid!));
        for (let i = 0; i < 120; i++) { try { if ((await query()).state === "ready") break; } catch {} await delay(250); }
        evidence.foreignSource = { entry: serviceEntry, source: oldRegistry.identity.source, version: oldRegistry.identity.sourceVersion };
      }
      const manager = await client.managerViaDaemon({ paths }, { op: "manager-start", space });
      assert.equal(manager.state, "answering", JSON.stringify(manager));
      managerPid = manager.pid; assert(managerPid); const managerIdentity = pin(managerPid);
      const daemon = await query();
      evidence.before = { daemon: pin(daemon.pid), manager: { ...managerIdentity, instanceId: manager.instanceId }, version: daemon.version };
      if (mode !== "foreign-preserving") {
        const fixture = join(root, "admission-seat"); mkdirSync(fixture, { mode: 0o700 });
        writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "cotal-admission-seat", version: report.target, type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
        writeFileSync(join(fixture, "seat.mjs"), `import {CotalEndpoint} from '@cotal-ai/core';import{readFileSync}from'node:fs';import{execFile}from'node:child_process';const e=process.env;const cmd=JSON.parse(e.COTAL_BEARER_CMD);const bearer=()=>new Promise((resolve,reject)=>execFile(cmd[0],cmd.slice(1),(error,out)=>error?reject(error):resolve(out.trim())));const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,bearer,sentinelCreds:readFileSync(e.COTAL_SENTINEL_CREDS,'utf8'),card:{owner:e.COTAL_OWNER,actor:e.COTAL_ACTOR,name:e.COTAL_NAME,role:'worker',kind:'agent',meta:{'ai.cotal.manager.instance':e.COTAL_MANAGER_INSTANCE}},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});await ep.start();for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));setInterval(()=>{},1000);`);
        writeFileSync(join(fixture, "index.js"), `import{registry}from'@cotal-ai/core';import{fileURLToPath}from'node:url';registry.register({kind:'connector',name:'admission-standin',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[fileURLToPath(new URL('./seat.mjs',import.meta.url))],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
        ok(await cotal("register real admission stand-in", ["ext", "add", fixture]), "stand-in registration");
        await client.managerViaDaemon({ paths }, { op: "managers-stop" });
        const freshManager = await client.managerViaDaemon({ paths }, { op: "manager-start", space });
        assert.equal(freshManager.state, "answering", "new fixture connector must be loaded by the actual Manager");
        const current = await managerRow();
        evidence.before.manager = { ...pin(current.row.pid), instanceId: current.row.instanceId };
        managerPid = current.row.pid;
        ok(await cotal("spawn original admission work", spawnArgs("admission_original", current.row.instanceId)), "original real seat");
        evidence.workBefore = record("work before", await ps("admission original work inventory", current.row.instanceId));
        assert.equal(evidence.workBefore.items.length, 1);
      }
      evidence.oldSets = census(oldVersionFiles());
      if (mode === "foreign-preserving") {
        oldRegistry!.activateTarget();
        const updater = spawn(process.execPath, [serviceEntry, "update", "--self", "--space", space], { cwd: context.project, env: { ...env, npm_config_prefix: evidence.foreignPrefix, npm_config_registry: oldRegistry!.url }, stdio: ["ignore", "pipe", "pipe"] });
        const producer: Record<string, any> = { stdout: "", stderr: "", entry: serviceEntry, pid: updater.pid }; evidence.fenceProducer = producer;
        let paused = false;
        updater.stdout!.on("data", bytes => { producer.stdout += bytes; if (!paused && producer.stdout.includes("Saving update recovery snapshot")) { paused = true; updater.kill("SIGSTOP"); } });
        updater.stderr!.on("data", bytes => producer.stderr += bytes);
        const ended = new Promise<void>((resolve, reject) => { updater.once("error", reject); updater.once("close", (code, signal) => { producer.exit = code; producer.signal = signal; resolve(); }); });
        try {
          for (let i = 0; i < 1800 && !paused && updater.exitCode === null && updater.signalCode === null; i++) await delay(100);
          assert(paused, `old public updater did not reach its real preparation boundary: ${producer.stderr}`);
          const status = await query(); assert(status.update.restartEvidence.prepared && status.update.restartEvidence.managers.every((row: any) => row.fenced && row.seats === 0));
          evidence.preparedFence = status.update.restartEvidence;
        } finally { updater.kill("SIGKILL"); await ended; }
      } else if (mode === "offline") { controls.pauseBroker(); brokerPaused = true; evidence.dependency = { brokerTraffic: "paused", nativeIdentity: evidence.before.daemon }; }
      else if (mode === "manager-unknown") { process.kill(managerPid!, "SIGSTOP"); managerPaused = true; evidence.dependency = { manager: "SIGSTOP", identity: evidence.before.manager }; }
      if (mode === "consent-stop") options["stop-agents"] = "true";
      env.npm_config_registry = preparationRegistry;
      process.env.npm_config_registry = preparationRegistry;
      const probePrefix = join(root, "target-checker");
      ok(await call("install exact target checker without publication", "npm", ["install", "-g", "--prefix", probePrefix, `cotal-ai@${report.target}`, "--ignore-scripts", "--no-audit", "--no-fund"]), "target checker install");
      const probeRoot = join(probePrefix, "lib/node_modules/cotal-ai");
      const declaration = JSON.parse(readFileSync(join(probeRoot, "package.json"), "utf8")).cotalPreinstall;
      const request = { v: 1, nonce: randomBytes(16).toString("hex"), installedEntry: cli, daemonArgv: [process.execPath, cli, "daemon", "serve"], flags: { space } };
      const observed = ok(await call("actual target read-only admission before update", process.execPath, [join(probeRoot, declaration.entry), JSON.stringify(request)], 130000), "actual target admission");
      const receipts = observed.stdout.split("\n").filter((line: string) => line.startsWith("COTAL_PREINSTALL_RESULT "));
      assert.equal(receipts.length, 1);
      evidence.targetReceipt = JSON.parse(receipts[0].slice("COTAL_PREINSTALL_RESULT ".length));
      assert.equal(evidence.targetReceipt.nonce, request.nonce); assert.equal(evidence.targetReceipt.installedEntry, cli);
      if (["foreign-preserving", "offline", "manager-unknown"].includes(mode)) assert.equal(evidence.targetReceipt.occupied, null, "unknown or foreign work is not invented zero");
    },
    async afterUpdate(update: any) {
      assert.equal(update.exit, 0, update.stderr);
      const callsBefore = report.calls.length;
      evidence.update = update;
      evidence.activationRecords = readdirSync(cotalHome).filter(name => /^update-activation-[a-f0-9]{64}\.json$/.test(name)).map(name => ({ name, record: JSON.parse(readFileSync(join(cotalHome, name), "utf8")) }));
      assert(callsBefore > 0, "public update calls must be recorded");
      if (managerPaused) { process.kill(managerPid!, "SIGCONT"); managerPaused = false; }
      if (brokerPaused) { controls.resumeBroker(); brokerPaused = false; }
      const status = await query();
      const current = status.managers?.find((row: any) => row.space === space); assert(current?.pid && current.instanceId);
      evidence.after = { daemon: pin(status.pid), manager: { ...pin(current.pid), instanceId: current.instanceId }, version: status.version };
      evidence.update = update;
      evidence.deferred = mode !== "consent-stop";
      if (evidence.deferred) {
        assert(alive(evidence.before.daemon) && alive(evidence.before.manager), "deferred update must retain exact native holders");
        assert.match(update.stdout, /activation deferred:.*software update finished/);
      } else assert.equal(status.version, report.target, "consented native generation must become B");
      evidence.oldSetsAfter = evidence.oldSets.map((row: { path: string; sha256: string }) => ({ ...row, observedSha256: existsSync(row.path) ? hash(readFileSync(row.path)) : null }));
      if (evidence.deferred) assert(evidence.oldSetsAfter.every((row: any) => row.observedSha256 === row.sha256), "retained connector generation must remain readable byte-for-byte");
      // Query through the actual Manager's public API after restoring the dependency. A new seat
      // exercises late connector-module use rather than only keeping a sleeping PID alive.
      if (mode !== "foreign-preserving") {
        evidence.workAfter = await ps("admission work after update", current.instanceId);
        if (mode === "consent-stop") assert(!evidence.workAfter.items.some((row: any) => row.name === "admission_original"));
        else assert(evidence.workAfter.items.some((row: any) => row.name === "admission_original"));
        ok(await cotal("spawn late admission work from retained Manager", spawnArgs("admission_late", current.instanceId)), "late real seat");
        evidence.lateWork = await ps("late admission work inventory", current.instanceId);
        assert(evidence.lateWork.items.some((row: any) => row.name === "admission_late"));
      } else {
        if (evidence.oldSetsAfter.length) {
          const managerHome = await import(pathToFileURL(join(pkg, "dist/daemon/manager.js")).href);
          const log = readFileSync(join(managerHome.daemonManagerRoot(space, cotalHome), "manager.log"), "utf8");
          const url = /console:\s+(http:\/\/127\.0\.0\.1:[0-9]+\/?)/.exec(log)?.[1];
          assert(url, "real Manager must record its own console URL");
          const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
          evidence.lateConsole = { url, status: response.status, sha256: hash(Buffer.from(await response.arrayBuffer())) };
          assert.equal(response.status, 200, "retained Manager late file read must still serve its console");
        }
        assert(evidence.oldSetsAfter.length > 0, "foreign legacy connector reads remain available");
      }
      evidence.recovery = existsSync(join(cotalHome, "update-recovery.json")) ? JSON.parse(readFileSync(join(cotalHome, "update-recovery.json"), "utf8")) : null;
      assert.equal(evidence.recovery, null);
      const bytes = Buffer.from(JSON.stringify(evidence)); const name = "target-admission-observations.json";
      writeFileSync(join(output, name), bytes, { mode: 0o600 });
      evidence.artifact = { name, bytes: bytes.length, sha256: hash(bytes) };
      check("target admission native action and retained work", true, { mode, deferred: evidence.deferred, before: evidence.before, after: evidence.after });
    },
  });
  return close;
  } catch (error) {
    if (foreign && foreign.exitCode === null && foreign.signalCode === null) {
      const ended = new Promise<void>(resolve => foreign!.once("close", () => resolve()));
      foreign.kill("SIGKILL"); await ended;
    }
    if (oldRegistry) await oldRegistry.close();
    await closeParticipant();
    for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
    Object.assign(process.env, priorEnv);
    throw error;
  }
}
