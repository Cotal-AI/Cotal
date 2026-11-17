import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { inspectInstalledUpdateRoute } from "./daemon-cell-diagnostics.mjs";
import { prepareUpdateParticipant } from "../implementations/auth/smoke/update-participant.fixture.js";

export interface Context { env: NodeJS.ProcessEnv; project: string; pkg: string; root: string; config: string; cotalHome: string; prefix: string; cli: string; output: string; options: Record<string, any>; report: Record<string, any>; call(label: string, file: string, argv: string[], timeout?: number): Promise<any>; cotal(label: string, argv: string[], timeout?: number): Promise<any>; check(name: string, passed: boolean, observed: unknown): void }
export const loadInstalled = (path: string) => import(pathToFileURL(path).href);
export const successful = (row: any) => { assert.equal(row.exit, 0, row.stdout + row.stderr); assert.equal(row.signal, null); assert.equal(row.timeout, false); return row; };
export function archiveUpdater(context: Context, evidence: Record<string, any>, name: string) {
  const { artifact: _artifact, ...saved } = evidence;
  const bytes = Buffer.from(JSON.stringify(saved));
  writeFileSync(join(context.output, name), bytes, { mode: 0o600 });
  evidence.artifact = { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Uses the harness's native service and leaves the next public update to the harness. */
export async function prepareDeadUpdater(context: Context) {
  assert(["linux", "darwin"].includes(process.platform));
  const { env, pkg, cli, report, cotal, cotalHome } = context;
  const prior = { ...process.env };
  const participant = await prepareUpdateParticipant(context);
  try {
  Object.assign(process.env, env);
  const e: Record<string, any> = { mode: "dead-updater", space: report.participant.space, observations: [] };
  report.deadUpdater = e;
  env.COTAL_SPACE = e.space; process.env.COTAL_SPACE = e.space;
  const { processBirth } = await loadInstalled(join(pkg, "dist/daemon/lifetime.js"));
  const { queryDaemon, managerViaDaemon } = await loadInstalled(join(pkg, "dist/daemon/client.js"));
  const { daemonPaths } = await loadInstalled(join(pkg, "dist/daemon/endpoint.js"));
  const paths = daemonPaths(env, cotalHome);
  const pin = (pid: number) => { const start = processBirth(pid); assert(start, `native birth unavailable: ${pid}`); return { pid, start }; };
  const query = async (label: string) => { const row = await queryDaemon({ paths }); assert(row.ok, JSON.stringify(row)); e.observations.push({ label, at: Date.now(), value: row.result }); return row.result; };
  const status = async (label: string, timeout = 30000) => {
    const script = `import{pathToFileURL}from'node:url';const p=${JSON.stringify(pkg)};await import(pathToFileURL(p+'/node_modules/@cotal-ai/auth/dist/index.js').href);const{control}=await import(pathToFileURL(p+'/node_modules/@cotal-ai/workspace/dist/control/index.js').href);console.log(JSON.stringify(await control({versionSkew:s=>s,roster:async()=>{throw Error('ambiguous fixture Manager')}},{space:${JSON.stringify(e.space)}},'managerStatus')));`;
    const call = successful(await context.call(label, process.execPath, ["--input-type=module", "-e", script], timeout));
    const value = JSON.parse(call.stdout); e.observations.push({ label, at: Date.now(), value, call });
    assert(value.ok, JSON.stringify(value)); assert.equal(value.data.instanceId, e.before.manager.instanceId); assert.equal(value.data.agentCount, 0); assert.equal(value.data.stopImpact.maintenance, "active"); assert.equal(value.data.stopImpact.resumeRequired, false); assert.equal(value.data.stopImpact.stopping, false); return value;
  };
  let updater: ReturnType<typeof spawn> | undefined, ended: Promise<void> | undefined, closed = false;
  const kill = async () => { if (updater && updater.exitCode === null && updater.signalCode === null) { assert.deepEqual(pin(updater.pid!), { pid: e.producer.pid, start: e.producer.start }); updater.kill("SIGKILL"); await ended; } };
  const close = async () => {
    if (closed) return;
    await kill();
    if (updater && updater.exitCode === null && updater.signalCode === null) throw new Error("updater retirement is unconfirmed; hosted Managers and fixture retained for runner teardown");
    closed = true;
    try { await managerViaDaemon({ paths }, { op: "managers-stop" }); }
    finally {
      try { await participant(); }
      finally { for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env, prior); }
    }
  };
  return Object.assign(close, {
    customDaemon: false,
    async beforeUpdate() {
      try {
        assert.equal(report.environment?.hostedDisposable, true, "native hosted service custody required");
        e.sourceVersion = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
        assert.equal(e.sourceVersion, report.source);
        e.sourceEntry = cli;
        e.sourceEntrySha256 = createHash("sha256").update(readFileSync(cli)).digest("hex");
        const manager = await managerViaDaemon({ paths }, { op: "manager-start", space: e.space });
        assert.equal(manager.state, "answering");
        const daemon = await query("initial daemon");
        assert.equal(daemon.pid, report.daemonBefore.pid);
        assert.equal(daemon.version, report.source);
        e.before = { daemon: pin(daemon.pid), manager: { ...pin(manager.pid), instanceId: manager.instanceId } };
        await status("initial Manager active");
        successful(await cotal("dead updater initial ps", ["ps", "--space", e.space, "--json"]));
        const producer: Record<string, any> = { argv: [cli, "update", "--self"], stdout: "", stderr: "" }; e.producer = producer;
        updater = spawn(process.execPath, producer.argv, { cwd: context.project, env, stdio: ["ignore", "pipe", "pipe"] });
        ended = new Promise<void>((resolve, reject) => { updater!.once("error", reject); updater!.once("close", (exit, signal) => { producer.exit = exit; producer.signal = signal; resolve(); }); });
        updater.stdout!.on("data", bytes => { producer.stdout += bytes; if (!producer.pausedAt && producer.stdout.includes("Saving update recovery snapshot")) { assert.deepEqual(pin(updater!.pid!), { pid: producer.pid, start: producer.start }); assert(updater!.kill("SIGSTOP")); producer.pausedAt = Date.now(); } });
        updater.stderr!.on("data", bytes => { producer.stderr += bytes; });
        await new Promise<void>((resolve, reject) => { updater!.once("spawn", resolve); updater!.once("error", reject); });
        Object.assign(producer, pin(updater.pid!));
        const deadline = Date.now() + 180000;
        while (!producer.pausedAt && updater.exitCode === null && updater.signalCode === null && Date.now() < deadline) await delay(50);
        assert(producer.pausedAt, producer.stdout + producer.stderr);
        await delay(2400);
        assert.deepEqual(pin(producer.pid), { pid: producer.pid, start: producer.start });
        e.heldObservedAt = Date.now();
        e.stoppedProcess = successful(await context.call("dead updater native stopped state", "ps", ["-o", "stat=", "-p", String(producer.pid)]));
        assert.match(e.stoppedProcess.stdout.trim(), /^T/, "native updater must actually be stopped");
        e.prepared = (await query("live owner held daemon")).update.restartEvidence;
        assert.equal(e.prepared.prepared, true);
        assert(e.prepared.managers.length > 0 && e.prepared.managers.every((m: any) => m.fenced && m.seats === 0));
        e.heldPs = await cotal("dead updater held ps", ["ps", "--space", e.space, "--json"]);
        assert.equal(e.heldPs.exit, 2, "current main read gate must refuse while fenced");
        assert.equal(e.heldPs.signal, null); assert.equal(e.heldPs.timeout, false);
        assert.match(e.heldPs.stdout + e.heldPs.stderr, /preserv|fenc|maintenance/i);
        assert.deepEqual(pin(producer.pid), { pid: producer.pid, start: producer.start });
        assert.equal((await query("live owner still prepared")).update.restartEvidence.prepared, true);
        assert.equal(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version, report.source);
        e.pausedExecution = inspectInstalledUpdateRoute(pkg, process.platform);
        e.pausedRecovery = existsSync(join(cotalHome, "update-recovery.json")) ? JSON.parse(readFileSync(join(cotalHome, "update-recovery.json"), "utf8")) : null;
        e.killRequestedAt = Date.now(); await kill(); e.killedAt = Date.now();
        let recovered = false, attempt = 0;
        while (Date.now() - e.killedAt < 15000) {
          const row = await cotal(`dead updater recovery ps ${++attempt}`, ["ps", "--space", e.space, "--json"], Math.max(1, 15000 - (Date.now() - e.killedAt)));
          if (row.exit === 0 && row.signal === null && row.timeout === false) { e.recoveredPs = row; recovered = true; break; }
          await delay(100);
        }
        assert(recovered, "public ps must recover autonomously within 15s");
        e.recoveredStatus = await status("autonomous Manager active", Math.max(1, 15000 - (Date.now() - e.killedAt)));
        e.recoveredAt = Date.now(); assert(e.recoveredAt - e.killedAt <= 15000);
        const restored = await query("autonomous daemon recovery");
        const row = restored.managers.find((m: any) => m.space === e.space);
        e.recovered = { daemon: pin(restored.pid), manager: { ...pin(row.pid), instanceId: row.instanceId } };
        assert.deepEqual(e.recovered, e.before);
        assert.equal(restored.update.restartEvidence.prepared, false);
      } catch (error) { await close(); throw error; }
    },
    async afterUpdate(update: any) {
      successful(update); e.update = update;
      const version = successful(await cotal("dead updater selected version", ["--version"])); e.selectedVersion = /^cotal-ai ([^\s]+)/.exec(version.stdout)?.[1]; assert.equal(e.selectedVersion, report.target);
      e.after = await query("after default update daemon"); assert.equal(e.after.version, report.target); assert.equal(e.after.update.restartEvidence.prepared, false);
      const manager = e.after.managers.find((m: any) => m.space === e.space); assert.equal(manager.state, "answering");
      successful(await cotal("dead updater after ps", ["ps", "--space", e.space, "--json"]));
      e.recovery = existsSync(join(cotalHome, "update-recovery.json")) ? JSON.parse(readFileSync(join(cotalHome, "update-recovery.json"), "utf8")) : null; assert.equal(e.recovery, null);
      archiveUpdater(context, e, "dead-updater-observations.json");
      context.check("dead updater release and next update alone", true, { before: e.before, recovered: e.recovered });
    },
  });
  } catch (error) {
    try { await participant(); } finally { for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env, prior); }
    throw error;
  }
}
