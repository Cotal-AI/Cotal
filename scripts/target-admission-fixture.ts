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

/** Public updater ownership proof. The caller owns the subsequent default A to B update. */
async function prepareUpdaterAdmission(context: Context) {
  assert(["linux", "darwin"].includes(process.platform));
  const { env, pkg, root, cli, prefix, options, report, call, cotal, cotalHome, output } = context;
  const mode = options["target-admission"], official = mode === "official18-escape";
  const prior = { ...process.env }, registry = env.npm_config_registry;
  const participant = await prepareUpdateParticipant(context);
  Object.assign(process.env, env);
  const e: Record<string, any> = { mode, space: report.participant.space, observations: [] };
  report.targetAdmission = e;
  const load = (path: string) => import(pathToFileURL(path).href);
  // Capture fixed native primitives before the official CLI replaces the main prefix.
  const { processBirth } = await load(join(pkg, "dist/daemon/lifetime.js"));
  const { queryDaemon, managerViaDaemon } = await load(join(pkg, "dist/daemon/client.js"));
  const { daemonPaths } = await load(join(pkg, "dist/daemon/endpoint.js"));
  await load(join(pkg, "node_modules/@cotal-ai/auth/dist/index.js"));
  const { control, controlPs } = await load(join(pkg, "node_modules/@cotal-ai/workspace/dist/control/index.js"));
  const paths = daemonPaths(env, cotalHome);
  const identity = (pid: number) => { const start = processBirth(pid); assert(start, `native birth unavailable: ${pid}`); return { pid, start }; };
  const alive = (row: any) => processBirth(row.pid) === row.start;
  const ok = (row: any) => { assert.equal(row.exit, 0, row.stdout + row.stderr); return row; };
  const query = async () => { const row = await queryDaemon({ paths }); assert(row.ok, JSON.stringify(row)); return row.result; };
  const controlClient = { versionSkew: (detail: string) => detail, roster: async () => { throw Error("ambiguous fixture Manager"); } };
  const status = async (label: string) => { const value = await control(controlClient, { space: e.space }, "managerStatus"); e.observations.push({ label, at: Date.now(), value }); return value; };
  const checkStatus = (row: any, maintenance: string) => { assert.equal(row.ok, true, JSON.stringify(row)); assert.equal(row.data.instanceId, e.before.manager.instanceId); assert.equal(row.data.agentCount, 0); assert.equal(row.data.stopImpact.maintenance, maintenance); assert.equal(row.data.stopImpact.resumeRequired, false); assert.equal(row.data.stopImpact.stopping, false); };
  let foreign: ReturnType<typeof spawn> | undefined, updater: ReturnType<typeof spawn> | undefined;
  let ended: Promise<void> | undefined, legacy: Awaited<ReturnType<typeof candidatePairRegistry>> | undefined;
  const restoreRegistry = () => { if (registry === undefined) { delete env.npm_config_registry; delete process.env.npm_config_registry; } else { env.npm_config_registry = registry; process.env.npm_config_registry = registry; } };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (updater && updater.exitCode === null && updater.signalCode === null) { assert(alive(e.fenceProducer), "updater identity changed before cleanup"); updater.kill("SIGKILL"); await ended; }
      if (foreign && foreign.exitCode === null && foreign.signalCode === null) {
        assert(alive(e.before.daemon), "foreign daemon identity changed before cleanup");
        const done = new Promise<void>(resolve => foreign!.once("close", () => resolve()));
        foreign.kill("SIGTERM"); const timer = setTimeout(() => { if (alive(e.before.daemon)) foreign!.kill("SIGKILL"); }, 10000);
        try { await done; } finally { clearTimeout(timer); }
        for (let i = 0; i < 100 && e.before?.manager && alive(e.before.manager); i++) await delay(100);
        assert(!alive(e.before.daemon), "owned foreign daemon remains alive after teardown");
        if (e.before.manager) assert(!alive(e.before.manager), "owned foreign Manager remains alive after teardown");
      } else if (!official) await managerViaDaemon({ paths }, { op: "managers-stop" });
    } finally {
      try { if (legacy) await legacy.close(); }
      finally { try { await participant(); } finally { restoreRegistry(); for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env, prior); } }
    }
  };
  return Object.assign(close, {
    customDaemon: official,
    async extensionInventory(stage: string) {
      const script = `import{pathToFileURL}from'node:url';import{join}from'node:path';import{readFileSync}from'node:fs';const p=${JSON.stringify(pkg)};const boot=await import(pathToFileURL(join(p,'dist/cotal.js')).href);const selected=boot.selectExecutionProgram(p);const w=await import(pathToFileURL(join(selected.root,'node_modules/@cotal-ai/workspace/dist/index.js')).href);const set=w.extensionSetPaths();const rows=JSON.parse(readFileSync(join(set.extensions,'extensions.json'),'utf8')).extensions;console.log(JSON.stringify(rows.map(row=>({...row,installedPath:join(set.extensions,'node_modules',row.pkg)}))));`;
      const rows = JSON.parse(ok(await call(`read ${stage} selected connector inventory`, process.execPath, ["--input-type=module", "-e", script])).stdout);
      assert(Array.isArray(rows) && rows.length >= 8); return rows;
    },
    async beforeUpdate() {
      try {
        let producerEntry = cli, producerPrefix = prefix, producerRegistry = registry;
        if (official) {
          assert(options["admission-legacy-candidate"] && options["admission-legacy-next"]);
          legacy = await candidatePairRegistry(options["admission-legacy-candidate"], options["admission-legacy-next"]);
          assert.equal(legacy.identity.source, options["admission-legacy-source"]);
          e.legacyRegistry = legacy.identity; legacy.activateTarget(); producerRegistry = legacy.url;
          const publicRegistry = "https://registry.npmjs.org/";
          const dist = ok(await call("official18 registry dist receipt", "npm", ["view", "cotal-ai@0.164.18", "dist", "--json", "--registry", publicRegistry]));
          e.officialDist = JSON.parse(dist.stdout); assert.match(e.officialDist.integrity, /^sha512-/); assert.match(e.officialDist.tarball, /^https:\/\/registry\.npmjs\.org\//);
          producerPrefix = join(root, "official18-prefix");
          for (const destination of [producerPrefix, prefix]) {
            ok(await call(destination === prefix ? "install official18 main" : "install official18 foreign", "npm", ["install", "-g", "--prefix", destination, "cotal-ai@0.164.18", "--registry", publicRegistry, "--no-audit", "--no-fund"]));
            assert.equal(JSON.parse(readFileSync(join(destination, "lib/node_modules/cotal-ai/package.json"), "utf8")).version, "0.164.18");
          }
          producerEntry = join(producerPrefix, "lib/node_modules/cotal-ai/dist/cotal.js");
          ok(await call("seed official18 foreign service", process.execPath, [producerEntry, "ext", "seed", "--repair"]));
          foreign = spawn(process.execPath, [producerEntry, "daemon", "serve"], { cwd: context.project, env: { ...env, npm_config_prefix: producerPrefix }, stdio: ["ignore", "pipe", "pipe"] });
          e.foreignLogs = "";
          for (const stream of [foreign.stdout!, foreign.stderr!]) stream.on("data", bytes => { e.foreignLogs += bytes; });
          await new Promise<void>((resolve, reject) => { foreign!.once("spawn", resolve); foreign!.once("error", reject); });
          e.before = { daemon: identity(foreign.pid!) };
          let ready = false;
          for (let i = 0; i < 120; i++) { try { if ((await query()).state === "ready") { ready = true; break; } } catch {} await delay(250); }
          assert(ready, "official daemon did not become ready");
          e.officialSource = { version: "0.164.18", entry: producerEntry };
        }
        const manager = await managerViaDaemon({ paths }, { op: "manager-start", space: e.space });
        assert.equal(manager.state, "answering");
        if (!official) { assert.equal(report.environment?.hostedDisposable, true, "killed updater requires hosted native service custody"); assert.equal(report.daemonBefore?.pid, (await query()).pid, "fixture must use harness native service"); }
        const daemon = await query();
        e.before = { daemon: identity(daemon.pid), manager: { ...identity(manager.pid), instanceId: manager.instanceId }, version: daemon.version };
        if (!official) checkStatus(await status("initial public status"), "active");
        updater = spawn(process.execPath, [producerEntry, "update", "--self", "--space", e.space], { cwd: context.project, env: { ...env, npm_config_prefix: producerPrefix, npm_config_registry: producerRegistry }, stdio: ["ignore", "pipe", "pipe"] });
        let paused = false;
        const producer: Record<string, any> = { entry: producerEntry, stdout: "", stderr: "", registry: producerRegistry }; e.fenceProducer = producer;
        ended = new Promise<void>((resolve, reject) => { updater!.once("error", reject); updater!.once("close", (code, signal) => { producer.exit = code; producer.signal = signal; resolve(); }); });
        await new Promise<void>((resolve, reject) => { updater!.once("spawn", resolve); updater!.once("error", reject); });
        Object.assign(producer, identity(updater.pid!));
        updater.stdout!.on("data", bytes => { producer.stdout += bytes; if (!paused && producer.stdout.includes("Saving update recovery snapshot")) { assert(alive(producer)); paused = updater!.kill("SIGSTOP"); producer.pausedAt = Date.now(); } });
        updater.stderr!.on("data", bytes => { producer.stderr += bytes; });
        for (let i = 0; i < 1800 && !paused && updater.exitCode === null && updater.signalCode === null; i++) await delay(100);
        assert(paused, `public updater never reached snapshot: ${producer.stdout}${producer.stderr}`);
        await delay(2400); assert(alive(producer), "paused owner must remain alive beyond reaper interval"); producer.heldMs = Date.now() - producer.pausedAt;
        const held = await query(); e.preparedFence = held.update.restartEvidence;
        assert(e.preparedFence.prepared && e.preparedFence.managers.every((row: any) => row.fenced && row.seats === 0));
        if (!official) {
          e.pausedPs = JSON.parse(ok(await cotal("paused updater public ps", ["ps", "--space", e.space, "--json"])).stdout);
          checkStatus(await status("paused public status"), "preserving");
          e.pausedList = await controlPs(controlClient, { space: e.space }, { readOnly: true }); assert.equal(e.pausedList.ok, true); assert.deepEqual(e.pausedList.rows, []);
        }
        e.preparedObservedAt = report.calls.length;
        assert(alive(producer)); assert((await query()).update.restartEvidence.prepared);
        e.pausedMainVersion = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
        assert.equal(e.pausedMainVersion, official ? "0.164.18" : report.source, "snapshot must precede main publication");
        updater.kill("SIGKILL"); await ended; e.killedAt = Date.now();
        if (official) {
          const bootstrap = await candidatePairRegistry(options.candidate, options["candidate-next"]);
          e.bootstrapRegistry = bootstrap.identity;
          env.npm_config_registry = bootstrap.url; process.env.npm_config_registry = bootstrap.url;
          try { ok(await call("plain npm fixed A escape", "npm", ["install", "-g", "--prefix", prefix, `cotal-ai@${report.source}`, "--registry", bootstrap.url, "--no-audit", "--no-fund"])); }
          finally { await bootstrap.close(); restoreRegistry(); }
          e.bootstrapVersion = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version; assert.equal(e.bootstrapVersion, report.source);
        } else {
          let active = false;
          while (Date.now() - e.killedAt < 15000) { const row = await status("autonomous recovery status"); if (row.ok && row.data?.stopImpact?.maintenance === "active") { checkStatus(row, "active"); active = true; break; } await delay(100); }
          e.recoveryElapsedMs = Date.now() - e.killedAt; assert(active && e.recoveryElapsedMs <= 15000, "same Manager must recover autonomously within 15s");
          const recovered = await query(); const row = recovered.managers.find((item: any) => item.space === e.space);
          e.recoveredManager = { ...identity(row.pid), instanceId: row.instanceId }; assert.deepEqual(e.recoveredManager, e.before.manager);
        }
        restoreRegistry();
      } catch (error) { await close(); throw error; }
    },
    async afterUpdate(update: any) {
      ok(update); e.update = update;
      const daemon = await query(), row = daemon.managers.find((item: any) => item.space === e.space);
      e.after = { daemon: identity(daemon.pid), manager: { ...identity(row.pid), instanceId: row.instanceId }, version: daemon.version };
      if (official) { assert.deepEqual(e.after.daemon, e.before.daemon); assert.deepEqual(e.after.manager, e.before.manager); assert.match(update.stdout, /activation deferred:.*software update finished|Software update finished\. The daemon and its Managers keep running their current generation until restarted:/s); }
      if (!official) { checkStatus(await status("after default update public status"), "active"); assert.equal(daemon.update.restartEvidence.prepared, false); }
      e.recovery = existsSync(join(cotalHome, "update-recovery.json")) ? JSON.parse(readFileSync(join(cotalHome, "update-recovery.json"), "utf8")) : null; assert.equal(e.recovery, null);
      const bytes = Buffer.from(JSON.stringify(e)), name = "target-admission-observations.json"; writeFileSync(join(output, name), bytes, { mode: 0o600 }); e.artifact = { name, bytes: bytes.length, sha256: hash(bytes) };
      context.check("public updater owner recovery and default self update", true, { mode, before: e.before, after: e.after });
    },
  });
}

/** Real participant and installed Manager composition for the five staged-admission coordinates. */
export async function prepareTargetAdmission(context: Context) {
  const { env, root, config, cotalHome, pkg, cli, options, report, call, cotal, check, output } = context;
  const mode = options["target-admission"] as string;
  if (["killed-updater", "official18-escape"].includes(mode)) return prepareUpdaterAdmission(context);
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
  const lifetime = await import(pathToFileURL(join(pkg, "dist/daemon/lifetime.js")).href);
  const startToken = (pid: number) => lifetime.processBirth(pid) as string | undefined;
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
    async extensionInventory(stage: string) {
      const script = `import{pathToFileURL}from'node:url';import{join}from'node:path';import{readFileSync,existsSync}from'node:fs';const p=${JSON.stringify(pkg)};const boot=await import(pathToFileURL(join(p,'dist/cotal.js')).href);const selected=boot.selectExecutionProgram(p);const w=await import(pathToFileURL(join(selected.root,'node_modules/@cotal-ai/workspace/dist/index.js')).href);const set=typeof w.extensionSetPaths==='function'?w.extensionSetPaths():undefined;const path=set?join(set.extensions,'extensions.json'):${JSON.stringify(join(config, "extensions/extensions.json"))};if(!existsSync(path))throw Error('selected extension inventory missing');const rows=JSON.parse(readFileSync(path,'utf8')).extensions;console.log(JSON.stringify(rows.map(row=>({...row,installedPath:join(set?set.extensions:${JSON.stringify(join(config, "extensions"))},'node_modules',row.pkg)}))));`;
      const observed = ok(await call(`read ${stage} selected connector inventory`, process.execPath, ["--input-type=module", "-e", script]), "selected inventory");
      const rows = JSON.parse(observed.stdout);
      assert(Array.isArray(rows) && rows.length >= 8, "all matching built-ins and runtime inventory must be real");
      return rows;
    },
    async beforeUpdate() {
      if (mode === "foreign-preserving") {
        assert(options["admission-legacy-candidate"] && options["admission-legacy-next"], "foreign preserving requires immutable legacy public-updater artifacts");
        oldRegistry = await candidatePairRegistry(options["admission-legacy-candidate"], options["admission-legacy-next"]);
        assert.equal(oldRegistry.identity.source, options["admission-legacy-source"], "legacy producer differs from frozen plan source");
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
        writeFileSync(join(fixture, "seat.mjs"), `import {CotalEndpoint} from '@cotal-ai/core';import{readFileSync,writeFileSync}from'node:fs';import{execFile}from'node:child_process';const e=process.env;const cmd=JSON.parse(e.COTAL_BEARER_CMD);const bearer=()=>new Promise((resolve,reject)=>execFile(cmd[0],cmd.slice(1),(error,out)=>error?reject(error):resolve(out.trim())));const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,bearer,sentinelCreds:readFileSync(e.COTAL_SENTINEL_CREDS,'utf8'),card:{owner:e.COTAL_OWNER,actor:e.COTAL_ACTOR,name:e.COTAL_NAME,role:'worker',kind:'agent',meta:{'ai.cotal.manager.instance':e.COTAL_MANAGER_INSTANCE}},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});await ep.start();writeFileSync(e.COTAL_ADMISSION_READY,JSON.stringify({name:e.COTAL_NAME,lifecycleUid:e.COTAL_LIFECYCLE_UID,managerInstance:e.COTAL_MANAGER_INSTANCE,pid:process.pid}),{mode:0o600});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));setInterval(()=>{},1000);`);
        writeFileSync(join(fixture, "index.js"), `import{registry}from'@cotal-ai/core';import{fileURLToPath}from'node:url';registry.register({kind:'connector',name:'admission-standin',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[fileURLToPath(new URL('./seat.mjs',import.meta.url))],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd),COTAL_NAME:o.name,COTAL_ADMISSION_READY:${JSON.stringify(join(root, "admission-ready"))}+'/'+o.name+'.json',COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
        mkdirSync(join(root, "admission-ready"), { mode: 0o700 });
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
        assert.match(update.stdout, /activation deferred:.*software update finished|Software update finished\. The daemon and its Managers keep running their current generation until restarted:/s);
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
        const ready = join(root, "admission-ready", "admission_late.json");
        for (let i = 0; i < 120 && !existsSync(ready); i++) await delay(250);
        assert(existsSync(ready), "late seat must authenticate and register, not merely be queued");
        evidence.lateReady = JSON.parse(readFileSync(ready, "utf8"));
        evidence.lateReady.start = pin(evidence.lateReady.pid).start;
        evidence.lateWork = await ps("late admission work inventory", current.instanceId);
        assert(evidence.lateWork.items.some((row: any) => row.name === "admission_late" && row.lifecycleUid === evidence.lateReady.lifecycleUid && typeof row.id === "string" && row.id), "late authenticated seat identity must match actual Manager inventory");
        assert.equal(evidence.lateReady.managerInstance, current.instanceId);
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
