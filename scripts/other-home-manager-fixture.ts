import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { prepareUpdateParticipant } from "../implementations/auth/smoke/update-participant.fixture.js";

type Result = { exit: number | null; stdout: string; stderr: string; signal?: string | null; timeout?: boolean };
export interface OtherHomeManagerContext {
  env: NodeJS.ProcessEnv;
  project: string;
  pkg: string;
  loadedRoot: string;
  root: string;
  config: string;
  cotalHome: string;
  prefix: string;
  cli: string;
  output: string;
  version: string;
  options: Record<string, any>;
  report: Record<string, any>;
  call(label: string, file: string, argv: string[], timeout?: number, overrides?: { env: NodeJS.ProcessEnv; cwd: string }): Promise<Result>;
  check(name: string, passed: boolean, observed: unknown): void;
}
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** The runner installs and primes the shared prefix before calling this fixture. No native unit is used. */
export async function prepareOtherHomeManager(context: OtherHomeManagerContext) {
  const { root, pkg, cli, report, version } = context;
  const mode = context.options["other-home-manager"];
  assert(["fresh-official-npm", "selected-generation"].includes(mode));
  assert(["linux", "darwin"].includes(process.platform));
  const priorEnv = { ...process.env };
  const home = join(root, "manager-home-a");
  const config = join(home, "config");
  const cotalHome = join(home, "cotal");
  const project = join(home, "project");
  const env: NodeJS.ProcessEnv = { ...context.env, HOME: home, XDG_CONFIG_HOME: config, COTAL_HOME: cotalHome,
    XDG_RUNTIME_DIR: join(home, "runtime"), TMPDIR: join(home, "tmp") };
  for (const path of [home, config, cotalHome, project, env.XDG_RUNTIME_DIR, env.TMPDIR]) {
    assert(path, "private homeA directory path is required");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    assert.equal(statSync(path).mode & 0o777, 0o700, `private homeA path: ${path}`);
  }
  assert.notEqual(home, context.env.HOME);
  assert.notEqual(config, context.env.XDG_CONFIG_HOME);
  assert.notEqual(cotalHome, context.cotalHome);
  assert.notEqual(project, context.project);
  assert.equal(env.npm_config_prefix, context.env.npm_config_prefix, "installation prefix remains shared");
  const evidence: Record<string, any> = { mode, version, homeA: { home, config, cotalHome, project },
    homeB: { home: context.env.HOME, config: context.config, cotalHome: context.cotalHome, project: context.project },
    observations: [], cleanupProbe: { status: "runner-public-trigger", reason: "Trigger is runner final public update command, not an independent direct collector API. Runner records the real call." } };
  report.otherHomeManager = evidence;
  const ok = (result: Result, label: string) => {
    assert.equal(result.exit, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert(!result.signal && !result.timeout, `${label}: signal or timeout`);
    return result;
  };
  const callA = (label: string, argv: string[]) => context.call(label, process.execPath, [cli, ...argv], 120000, { env, cwd: project });
  let closeParticipant: (() => Promise<void>) | undefined;
  let daemon: ReturnType<typeof spawn> | undefined;
  let daemonExit: Promise<void> | undefined;
  let client: any, paths: any, birth: ((pid: number) => string | undefined) | undefined;
  let before: any;
  const owned = new Map<number, string>();
  let closed = false;
  const pin = (pid: number) => {
    const start = birth!(pid);
    assert(start, `native birth token required: ${pid}`);
    owned.set(pid, start);
    return { pid, start };
  };
  const query = async () => {
    const reply = await client.queryDaemon({ paths });
    assert(reply.ok, "homeA real daemon must answer");
    return reply.result;
  };
  const manager = async () => {
    const status = await query();
    const row = status.managers?.find((item: any) => item.space === evidence.space);
    assert(row?.pid && row.instanceId, "homeA actual Manager identity required");
    return { status, row };
  };
  const exclusions: { path: string; reason: string }[] = [];
  const mutableHolderPaths = new Set<string>();
  const census = (pathsToRead: string[]) => {
    const rows: { path: string; sha256: string }[] = [];
    const visit = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (mutableHolderPaths.has(child)) {
          exclusions.push({ path: child, reason: "Mutable generation holder state, not loaded program bytes" });
          continue;
        }
        if (exclusions.some(row => row.path === child)) continue;
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) rows.push({ path: child, sha256: sha256(readFileSync(child)) });
      }
    };
    for (const path of pathsToRead) visit(path);
    assert(rows.length, "loaded execution graph and connector set must contain real files");
    return rows;
  };
  async function close() {
    if (closed) return evidence.remaining as [];
    closed = true;
    try {
      if (client && paths) await client.managerViaDaemon({ paths }, { op: "managers-stop" });
    } finally {
      try {
        if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
          daemon.kill("SIGTERM");
          const timer = setTimeout(() => daemon?.kill("SIGKILL"), 10000);
          try { await daemonExit; } finally { clearTimeout(timer); }
        }
      } finally {
        try { await closeParticipant?.(); }
        finally {
          for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
          Object.assign(process.env, priorEnv);
          evidence.remaining = birth ? [...owned].filter(([pid, start]) => birth!(pid) === start) : [];
          report.cleanup = { ...report.cleanup, remaining: evidence.remaining };
          assert.equal(evidence.remaining.length, 0, "owned homeA processes must exit");
        }
      }
    }
    return evidence.remaining as [];
  }
  try {
    const participantReport: Record<string, any> = {};
    closeParticipant = await prepareUpdateParticipant({ env, project, cotalHome, report: participantReport });
    evidence.participant = participantReport;
    evidence.space = participantReport.participant.space;
    Object.assign(process.env, env);
    client = await import(pathToFileURL(join(context.loadedRoot, "dist/daemon/client.js")).href);
    const endpoint = await import(pathToFileURL(join(context.loadedRoot, "dist/daemon/endpoint.js")).href);
    const lifetime = await import(pathToFileURL(join(context.loadedRoot, "dist/daemon/lifetime.js")).href);
    birth = (pid: number) => lifetime.processBirth(pid);
    paths = endpoint.daemonPaths(env, cotalHome);
    const readyDir = join(home, "seat-ready");
    const connector = join(home, "standin");
    mkdirSync(readyDir, { mode: 0o700 }); mkdirSync(connector, { mode: 0o700 });
    writeFileSync(join(connector, "package.json"), JSON.stringify({ name: "cotal-other-home-seat", version, type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
    writeFileSync(join(connector, "seat.mjs"), `import {CotalEndpoint} from '@cotal-ai/core';import{readFileSync,writeFileSync}from'node:fs';import{execFile}from'node:child_process';const e=process.env;const cmd=JSON.parse(e.COTAL_BEARER_CMD);const bearer=()=>new Promise((resolve,reject)=>execFile(cmd[0],cmd.slice(1),(error,out)=>error?reject(error):resolve(out.trim())));const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,bearer,sentinelCreds:readFileSync(e.COTAL_SENTINEL_CREDS,'utf8'),card:{owner:e.COTAL_OWNER,actor:e.COTAL_ACTOR,name:e.COTAL_NAME,role:'worker',kind:'agent',meta:{'ai.cotal.manager.instance':e.COTAL_MANAGER_INSTANCE}},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});await ep.start();writeFileSync(e.COTAL_READY,JSON.stringify({name:e.COTAL_NAME,lifecycleUid:e.COTAL_LIFECYCLE_UID,managerInstance:e.COTAL_MANAGER_INSTANCE,pid:process.pid}),{mode:0o600});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));setInterval(()=>{},1000);`);
    writeFileSync(join(connector, "index.js"), `import{registry}from'@cotal-ai/core';import{fileURLToPath}from'node:url';registry.register({kind:'connector',name:'other-home-standin',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[fileURLToPath(new URL('./seat.mjs',import.meta.url))],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd),COTAL_NAME:o.name,COTAL_READY:${JSON.stringify(readyDir)}+'/'+o.name+'.json',COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
    ok(await callA("homeA seed actual installed generation", ["ext", "seed", "--repair"]), "seed");
    ok(await callA("homeA register authenticated stand-in", ["ext", "add", connector]), "register connector");
    daemon = spawn(process.execPath, [cli, "daemon", "serve"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    evidence.daemonCommand = { file: process.execPath, argv: [cli, "daemon", "serve"], cwd: project, stdout: "", stderr: "" };
    daemon.stdout!.on("data", bytes => evidence.daemonCommand.stdout += bytes);
    daemon.stderr!.on("data", bytes => evidence.daemonCommand.stderr += bytes);
    daemonExit = new Promise<void>((resolve, reject) => { daemon!.once("error", reject); daemon!.once("close", (code, signal) => { evidence.daemonCommand.exit = code; evidence.daemonCommand.signal = signal; resolve(); }); });
    await new Promise<void>((resolve, reject) => { daemon!.once("spawn", resolve); daemon!.once("error", reject); });
    const daemonIdentity = pin(daemon.pid!);
    for (let i = 0; i < 120; i++) { try { if ((await query()).state === "ready") break; } catch {} await delay(250); }
    assert.equal((await query()).state, "ready");
    const started = await client.managerViaDaemon({ paths }, { op: "manager-start", space: evidence.space });
    assert.equal(started.state, "answering", JSON.stringify(started));
    const initial = await manager();
    assert.equal(initial.status.version, version);
    before = evidence.before = { daemon: daemonIdentity, manager: { ...pin(initial.row.pid), instanceId: initial.row.instanceId }, version };
    const spawnSeat = async (name: string) => {
      ok(await callA(`homeA spawn ${name}`, ["spawn", "--agent", "other-home-standin", "--on", before.manager.instanceId, "--name", name, "--detach", "--no-events", "--space", evidence.space]), "spawn authenticated work");
      const file = join(readyDir, `${name}.json`);
      for (let i = 0; i < 120 && !existsSync(file); i++) await delay(250);
      assert(existsSync(file), "seat must authenticate and register presence");
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(receipt.managerInstance, before.manager.instanceId);
      return { ...receipt, ...pin(receipt.pid) };
    };
    evidence.originalSeat = await spawnSeat("other_home_original");
    before.work = JSON.parse(ok(await callA("homeA original work inventory", ["ps", "--on", before.manager.instanceId, "--space", evidence.space, "--json"]), "original inventory").stdout).result;
    assert(before.work.items.some((row: any) => row.name === evidence.originalSeat.name && row.lifecycleUid === evidence.originalSeat.lifecycleUid), "original authenticated work must appear in actual inventory");
    // Resolve the actual selected graph in a fresh installed process, not from source labels.
    const graphScript = `import{pathToFileURL}from'node:url';import{join}from'node:path';const p=${JSON.stringify(pkg)};const b=await import(pathToFileURL(join(p,'dist/cotal.js')).href);const s=b.selectExecutionProgram(p);const w=await import(pathToFileURL(join(s.root,'node_modules/@cotal-ai/workspace/dist/index.js')).href);console.log(JSON.stringify({root:s.root,set:w.extensionSetPaths()}));`;
    const graph = JSON.parse(ok(await context.call("homeA resolve loaded installed graph", process.execPath, ["--input-type=module", "-e", graphScript], 120000, { env, cwd: project }), "resolve graph").stdout);
    assert(graph.root && graph.set?.set && graph.set?.extensions, "installed selected graph and complete connector generation required");
    evidence.loadedGraph = graph;
    if (graph.root === pkg) {
      exclusions.push({ path: join(pkg, "dist/cotal.js"), reason: "Canonical bootstrap is legitimately republished by public self-update. Loaded cotal-program.js and every other old program file remain hashed." });
    }
    assert.equal(graph.root, context.loadedRoot, "runner selected root must match actual launcher selection");
    mutableHolderPaths.add(join(graph.set.set, "holders"));
    const graphFiles = census([graph.root]);
    const setFiles = census([graph.set.set]);
    before.graph = graphFiles;
    before.sets = setFiles;
    evidence.hashExclusions = exclusions;
    evidence.canonicalBootstrapBefore = { path: join(pkg, "dist/cotal.js"), sha256: sha256(readFileSync(join(pkg, "dist/cotal.js"))) };
    evidence.oldFiles = [...graphFiles, ...setFiles];
    let observation = 0;
    async function observe(label: string) {
      const current = await manager();
      assert.equal(current.row.instanceId, before.manager.instanceId);
      assert.equal(current.row.pid, before.manager.pid);
      assert.equal(birth!(current.row.pid), before.manager.start);
      assert.equal(birth!(before.daemon.pid), before.daemon.start);
      assert.equal(birth!(evidence.originalSeat.pid), evidence.originalSeat.start);
      const files = evidence.oldFiles.map((row: any) => ({ ...row, observedSha256: existsSync(row.path) ? sha256(readFileSync(row.path)) : null }));
      assert(files.every((row: any) => row.sha256 === row.observedSha256), "loaded old graph and connectors must survive byte-for-byte");
      const seat = await spawnSeat(`other_home_late_${++observation}`);
      const work = JSON.parse(ok(await callA(`homeA inventory ${label}`, ["ps", "--on", before.manager.instanceId, "--space", evidence.space, "--json"]), "inventory").stdout).result;
      for (const expected of [evidence.originalSeat, seat]) assert(work.items.some((row: any) => row.name === expected.name && row.lifecycleUid === expected.lifecycleUid && typeof row.id === "string" && row.id), "authenticated seat lifecycle must match actual Manager inventory");
      const managerModule = await import(pathToFileURL(join(context.loadedRoot, "dist/daemon/manager.js")).href);
      const log = readFileSync(join(managerModule.daemonManagerRoot(evidence.space, cotalHome), "manager.log"), "utf8");
      const url = /console:\s+(http:\/\/127\.0\.0\.1:[0-9]+\/?)/.exec(log)?.[1]; assert(url, "actual console URL required");
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const consoleRead = { url, status: response.status, sha256: sha256(Buffer.from(await response.arrayBuffer())) };
      assert.equal(response.status, 200, "old Manager late console file read");
      assert.equal(current.status.version, version, "retained daemon still runs its original generation");
      const pathsIn = (rows: { path: string }[]) => new Set(rows.map(row => row.path));
      const graphPaths = pathsIn(graphFiles), setPaths = pathsIn(setFiles);
      const canonicalBootstrap = { path: join(pkg, "dist/cotal.js"), sha256: sha256(readFileSync(join(pkg, "dist/cotal.js"))) };
      const result = { label, version, canonicalBootstrap, manager: { pid: current.row.pid, start: birth!(current.row.pid), instanceId: current.row.instanceId },
        graph: files.filter((row: any) => graphPaths.has(row.path)), sets: files.filter((row: any) => setPaths.has(row.path)),
        lateReady: seat, lateWork: work, work, console: consoleRead };
      evidence.observations.push(result);
      writeFileSync(join(context.output, "other-home-manager-observations.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
      context.check(`other-home retained Manager ${label}`, true, result);
      return result;
    }
    return { before, homes: { manager: { project, config, cotalHome }, updater: { project: context.project, config: context.config, cotalHome: context.cotalHome } }, customDaemon: true as const, observe, close,
      runFromOtherHome: (label: string, argv: string[]) => context.call(label, process.execPath, [cli, ...argv], 120000, { env: context.env, cwd: context.project }) };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "fixture setup and cleanup failed"); }
    throw error;
  }
}
