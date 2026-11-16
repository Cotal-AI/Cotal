import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

interface Context { env: NodeJS.ProcessEnv; project: string; pkg: string; root: string; config: string; cotalHome: string; prefix: string; cli: string; output: string; options: Record<string, any>; report: Record<string, any>; call(label: string, file: string, argv: string[], timeout?: number): Promise<any>; cotal(label: string, argv: string[], timeout?: number): Promise<any>; check(name: string, passed: boolean, observed: unknown): void }
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const load = (path: string) => import(pathToFileURL(path).href);
const ok = (row: any) => { assert.equal(row.exit, 0, row.stdout + row.stderr); return row; };

/** Keep the public released updater as the caller, including its own floor and target reader. */
export async function prepareReleasedUpdater(context: Context) {
  const { env, pkg, root, cli, options, report, call, cotal, cotalHome, output } = context;
  const mode = options["released-updater"];
  assert(["no-service", "empty-owned-service", "owned-agent-consent", "foreground-foreign-prefix"].includes(mode));
  assert(["linux", "darwin"].includes(process.platform));
  assert.equal(report.source, "0.164.18");
  assert.equal(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version, "0.164.18");
  const prior = { ...process.env };
  const participant = mode === "no-service" ? undefined : await (await import("../implementations/auth/smoke/update-participant.fixture.js")).prepareUpdateParticipant(context);
  Object.assign(process.env, env);
  const space = report.participant?.space;
  if (space) { env.COTAL_SPACE = space; process.env.COTAL_SPACE = space; }
  const e: Record<string, any> = { mode, sourceVersion: "0.164.18", sourceEntry: cli, space, observations: [] };
  report.releasedUpdater = e;
  const { processBirth } = await load(join(pkg, "dist/daemon/lifetime.js"));
  const client = await load(join(pkg, "dist/daemon/client.js"));
  const { daemonPaths } = await load(join(pkg, "dist/daemon/endpoint.js"));
  const paths = daemonPaths(env, cotalHome);
  const pin = (pid: number) => { const start = processBirth(pid); assert(start, `native birth unavailable: ${pid}`); return { pid, start }; };
  const query = async () => { const row = await client.queryDaemon({ paths }); assert(row.ok, JSON.stringify(row)); return row.result; };
  const snapshot = async () => {
    const row = await query();
    return { daemon: pin(row.pid), version: row.version, managers: row.managers.map((m: any) => ({ space: m.space, state: m.state, instanceId: m.instanceId, ...(m.pid ? pin(m.pid) : {}) })), update: row.update };
  };
  let foreign: ReturnType<typeof spawn> | undefined;
  let closed = false, archived = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (foreign && foreign.exitCode === null && foreign.signalCode === null) {
        assert.deepEqual(pin(foreign.pid!), e.foreignIdentity, "foreign custody changed before cleanup");
        const done = new Promise<void>(resolve => foreign!.once("close", () => resolve()));
        foreign.kill("SIGTERM");
        const timer = setTimeout(() => { if (processBirth(foreign!.pid!) === e.foreignIdentity.start) foreign!.kill("SIGKILL"); }, 10000);
        try { await done; } finally { clearTimeout(timer); }
      } else if (mode !== "no-service") await client.managerViaDaemon({ paths }, { op: "managers-stop" });
    } finally {
      try { await participant?.(); } finally {
        for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
        Object.assign(process.env, prior);
      }
    }
  };
  return Object.assign(close, {
    customDaemon: mode === "foreground-foreign-prefix",
    async extensionInventory(stage: string) {
      const script = `import{pathToFileURL}from'node:url';import{join}from'node:path';import{readFileSync,existsSync}from'node:fs';const p=${JSON.stringify(pkg)};const boot=await import(pathToFileURL(join(p,'dist/cotal.js')).href);const selected=boot.selectExecutionProgram(p);const w=await import(pathToFileURL(join(selected.root,'node_modules/@cotal-ai/workspace/dist/index.js')).href);const extensions=typeof w.extensionSetPaths==='function'?w.extensionSetPaths().extensions:w.extensionsDir();const manifest=join(extensions,'extensions.json');const rows=!existsSync(manifest)&&${JSON.stringify(mode === "no-service")}&&${JSON.stringify(stage)}==='before'?[]:JSON.parse(readFileSync(manifest,'utf8')).extensions;console.log(JSON.stringify(rows.map(row=>({...row,installedPath:join(extensions,'node_modules',row.pkg)}))));`;
      const rows = JSON.parse(ok(await call(`released ${stage} selected extension inventory`, process.execPath, ["--input-type=module", "-e", script])).stdout);
      assert(Array.isArray(rows) && (mode === "no-service" && stage === "before" || rows.length >= 8)); return rows;
    },
    async beforeUpdate() {
      try {
        const publicRegistry = "https://registry.npmjs.org/";
        e.officialDist = JSON.parse(ok(await call("released source public dist", "npm", ["view", "cotal-ai@0.164.18", "dist", "--json", "--registry", publicRegistry])).stdout);
        assert.match(e.officialDist.integrity, /^sha512-/);
        assert.match(e.officialDist.tarball, /^https:\/\/registry\.npmjs\.org\//);
        e.sourcePackageSha256 = hash(readFileSync(join(pkg, "package.json")));
        if (mode === "foreground-foreign-prefix") {
          const prefix = join(root, "released-foreign-prefix");
          ok(await call("install public18 foreign prefix", "npm", ["install", "-g", "--prefix", prefix, "cotal-ai@0.164.18", "--registry", publicRegistry, "--no-audit", "--no-fund"]));
          const entry = join(prefix, "lib/node_modules/cotal-ai/dist/cotal.js");
          assert.equal(JSON.parse(readFileSync(join(prefix, "lib/node_modules/cotal-ai/package.json"), "utf8")).version, "0.164.18");
          e.foreignSource = { prefix, entry, version: "0.164.18" };
          ok(await call("seed public18 foreign prefix", process.execPath, [entry, "ext", "seed", "--repair"]));
          foreign = spawn(process.execPath, [entry, "daemon", "serve"], { cwd: context.project, env: { ...env, npm_config_prefix: prefix }, stdio: ["ignore", "pipe", "pipe"] });
          e.foreignLogs = "";
          foreign.stdout!.on("data", bytes => { if (!archived) e.foreignLogs += bytes; });
          foreign.stderr!.on("data", bytes => { if (!archived) e.foreignLogs += bytes; });
          await new Promise<void>((resolve, reject) => { foreign!.once("spawn", resolve); foreign!.once("error", reject); });
          e.foreignIdentity = pin(foreign.pid!);
          let ready = false;
          for (let i = 0; i < 120; i++) { try { if ((await query()).state === "ready") { ready = true; break; } } catch {} await delay(250); }
          assert(ready, e.foreignLogs);
        }
        if (mode === "owned-agent-consent") {
          await client.managerViaDaemon({ paths }, { op: "managers-stop" });
          await installSeat(context);
          options["stop-agents"] = "true";
        }
        if (mode !== "no-service") {
          const manager = await client.managerViaDaemon({ paths }, { op: "manager-start", space });
          assert.equal(manager.state, "answering");
          if (mode === "owned-agent-consent") {
            ok(await cotal("released spawn authenticated seat", ["spawn", "--agent", "admission-standin", "--on", manager.instanceId, "--name", "released_original", "--detach", "--no-events", "--space", space]));
            const ready = join(root, "released-ready.json");
            for (let i = 0; i < 120 && !existsSync(ready); i++) await delay(250);
            assert(existsSync(ready), "real authenticated seat must become ready");
            e.seat = JSON.parse(readFileSync(ready, "utf8")); Object.assign(e.seat, pin(e.seat.pid));
            e.workBefore = JSON.parse(ok(await cotal("released seat before inventory", ["ps", "--on", manager.instanceId, "--space", space, "--json"])).stdout).result;
            assert.equal(e.workBefore.items.length, 1);
          }
          e.before = await snapshot();
          assert.equal(e.before.version, "0.164.18");
        } else e.before = null;
        // Install the exact candidate normally. This is an independent probe, never the updater.
        const probePrefix = join(root, "released-target-probe");
        ok(await call("released install exact target probe", "npm", ["install", "-g", "--prefix", probePrefix, `cotal-ai@${report.target}`, "--no-audit", "--no-fund"]));
        const probeRoot = join(probePrefix, "lib/node_modules/cotal-ai");
        assert.equal(JSON.parse(readFileSync(join(probeRoot, "package.json"), "utf8")).version, report.target);
        e.probeRoot = probeRoot;
        const request = { v: 1, nonce: randomBytes(16).toString("hex"), installedEntry: cli, daemonArgv: [process.execPath, cli, "daemon", "serve"], flags: space ? { space } : {} };
        const script = `import{pathToFileURL}from'node:url';const p=${JSON.stringify(pkg)},target=${JSON.stringify(probeRoot)},request=${JSON.stringify(request)};await import(pathToFileURL(p+'/node_modules/@cotal-ai/auth/dist/index.js').href);const floor=await import(pathToFileURL(p+'/dist/daemon/execution-preinstall.js').href);const reader=await import(pathToFileURL(p+'/dist/daemon/execution-preinstall-client.js').href);let phase='floor';try{const legacy=await floor.readExecutionPreinstall(request);phase='target-reader';const receipt=await reader.targetExecutionPreinstall(target,request.installedEntry,request.daemonArgv,request.flags);console.log('RELEASED_READER_RESULT '+JSON.stringify({accepted:true,legacy,receipt}));}catch(error){console.log('RELEASED_READER_RESULT '+JSON.stringify({accepted:false,phase,error:String(error?.message??error)}));process.exitCode=1;}`;
        const observed = await call("released reader probe before update", process.execPath, ["--input-type=module", "-e", script], 150000);
        const lines = observed.stdout.split("\n").filter((line: string) => line.startsWith("RELEASED_READER_RESULT "));
        assert.equal(lines.length, 1); e.readerProbe = JSON.parse(lines[0].slice("RELEASED_READER_RESULT ".length));
        e.readerProbeCall = observed;
        if (!e.readerProbe.accepted) {
          e.floorRefused = e.readerProbe.phase === "floor";
          archived = true;
          const bytes = Buffer.from(JSON.stringify(e)), name = "released-updater-floor-refusal.json";
          writeFileSync(join(output, name), bytes, { mode: 0o600 });
          e.artifact = { name, bytes: bytes.length, sha256: hash(bytes) };
        }
        ok(observed); assert.equal(e.readerProbe.accepted, true);
        const project = (row: any) => ({ daemon: row.daemon, hostedSpaces: row.hostedSpaces, occupied: row.occupied });
        assert.deepEqual(project(e.readerProbe.receipt), project(e.readerProbe.legacy), "target top-level projection differs from released floor");
      } catch (error) { await close(); throw error; }
    },
    async afterUpdate(update: any) {
      ok(update); e.update = update;
      const versionOutput = ok(await cotal("released selected target version", ["--version"])).stdout;
      e.selectedVersion = /^cotal-ai ([^\s]+)(?:\s|$)/.exec(versionOutput)?.[1];
      assert.equal(e.selectedVersion, report.target);
      if (mode === "no-service") {
        const observed = await call("released no-service custody after", process.execPath, [cli, "daemon", "status", "--json"]);
        e.noServiceAfter = observed;
        assert.equal(observed.exit, 2, "no-service public update must not create a running service");
        e.after = null;
      }
      else {
        e.after = await snapshot();
        if (mode === "foreground-foreign-prefix") {
          assert.deepEqual(e.after.daemon, e.before.daemon);
          assert.deepEqual(e.after.managers, e.before.managers);
          assert.deepEqual(e.after.update?.restartEvidence, e.before.update?.restartEvidence);
        } else {
          assert.equal(e.after.version, report.target);
          assert(e.after.managers.length > 0 && e.after.managers.every((m: any) => m.state === "answering"));
          if (e.seat) { e.seatStopped = processBirth(e.seat.pid) !== e.seat.start; assert(e.seatStopped, "consented seat must stop"); }
        }
      }
      e.recovery = existsSync(join(cotalHome, "update-recovery.json")) ? JSON.parse(readFileSync(join(cotalHome, "update-recovery.json"), "utf8")) : null;
      assert.equal(e.recovery, null);
      archived = true;
      const bytes = Buffer.from(JSON.stringify(e)), name = "released-updater-observations.json";
      writeFileSync(join(output, name), bytes, { mode: 0o600 }); e.artifact = { name, bytes: bytes.length, sha256: hash(bytes) };
      context.check("released updater public hop and custody", true, { mode, before: e.before, after: e.after });
    },
  });
}

async function installSeat({ root, report, cotal }: Context) {
  const fixture = join(root, "released-seat"); mkdirSync(fixture, { mode: 0o700 });
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "cotal-released-seat", version: report.target, type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
  writeFileSync(join(fixture, "seat.mjs"), `import{CotalEndpoint}from'@cotal-ai/core';import{readFileSync,writeFileSync}from'node:fs';import{execFile}from'node:child_process';const e=process.env,cmd=JSON.parse(e.COTAL_BEARER_CMD);const bearer=()=>new Promise((resolve,reject)=>execFile(cmd[0],cmd.slice(1),(err,out)=>err?reject(err):resolve(out.trim())));const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,bearer,sentinelCreds:readFileSync(e.COTAL_SENTINEL_CREDS,'utf8'),card:{owner:e.COTAL_OWNER,actor:e.COTAL_ACTOR,name:e.COTAL_NAME,role:'worker',kind:'agent',meta:{'ai.cotal.manager.instance':e.COTAL_MANAGER_INSTANCE}},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});await ep.start();writeFileSync(e.COTAL_RELEASED_READY,JSON.stringify({pid:process.pid,name:e.COTAL_NAME,lifecycleUid:e.COTAL_LIFECYCLE_UID}),{mode:0o600});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>ep.stop().finally(()=>process.exit(0)));setInterval(()=>{},1000);`);
  writeFileSync(join(fixture, "index.js"), `import{registry}from'@cotal-ai/core';import{fileURLToPath}from'node:url';registry.register({kind:'connector',name:'admission-standin',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[fileURLToPath(new URL('./seat.mjs',import.meta.url))],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd),COTAL_NAME:o.name,COTAL_RELEASED_READY:${JSON.stringify(join(root, "released-ready.json"))},COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
  ok(await cotal("released register real seat", ["ext", "add", fixture]));
}
