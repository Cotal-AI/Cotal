/**
 * Concurrent first-start on one fresh root (#1263).
 *
 * Two manager processes that both observe no identity file used to mint different instance ids
 * and take different leases. This suite forks N real Manager.start() processes against one root
 * after a shared barrier, then asserts exactly one identity exists and losers refuse with
 * `already serves space`. Sequential start is the control that the established fence still holds.
 *
 * PRE-FIX CONTROL: the load-absent-then-write probe minted two in-memory ids in 2/40 rounds on
 * origin/main. A Manager.start that still calls saveManagerInstanceIdentity must fail the unique-id
 * cell the same way.
 *
 * Throwaway nats-server on a free loopback port. Never the live mesh.
 *
 * Run: pnpm smoke:manager-fresh-root-identity
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const home = mkdtempSync(join(tmpdir(), "cotal-i1263-home-"));
process.env.COTAL_HOME = home;
const { probeConnect } = await import("@cotal-ai/core");
const { loadManagerInstanceIdentity, recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import("../src/manager.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HERE = fileURLToPath(import.meta.url);
/** The ambient environment without this run's COTAL_ settings, for a worker to set its own. */
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
};
const TSX = join(fileURLToPath(new URL("../../../", import.meta.url)), "node_modules", ".bin", "tsx");

if (process.env.COTAL_I1263_WORKER === "1") {
  const root = process.env.COTAL_I1263_ROOT!;
  const space = process.env.COTAL_I1263_SPACE!;
  const server = process.env.COTAL_I1263_SERVER!;
  const barrier = process.env.COTAL_I1263_BARRIER!;
  while (!existsSync(barrier)) await wait(5);
  const m = new Manager({ space, servers: server, runtime: "pty", workspaceRoot: root });
  try {
    await m.start();
    const id = (m as unknown as { managerInstanceId: string }).managerInstanceId;
    process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, instanceId: id }) + "\n");
    await new Promise(() => {});
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, pid: process.pid, error: (e as Error).message }) + "\n");
    process.exit(2);
  }
}

const N = 4;
const ROUNDS = 6;
const SPACE = "issue-1263-start";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? extra : ""); }
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const kids: ChildProcess[] = [];
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}i1263-js-`))], { stdio: "ignore" });
  teardownOnSignal(broker);
  kids.push(broker);
  for (let i = 0; i < 60; i++) { if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break; await wait(120); }

  const seqRoot = mkdtempSync(join(tmpdir(), "cotal-i1263-seq-"));
  mkdirSync(join(seqRoot, ".cotal", "agents"), { recursive: true });
  recordMesh({ space: SPACE, server: SERVER, root: seqRoot, mode: "open", ts: new Date().toISOString() });
  const first = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: seqRoot });
  await first.start();
  const firstId = (first as unknown as { managerInstanceId: string }).managerInstanceId;
  // The second start runs in a process of its own, as a second manager does. In this process the
  // lease names this pid, which a restart reads as its own crashed predecessor (#4092).
  const seqBarrier = join(seqRoot, "go");
  writeFileSync(seqBarrier, "go");
  const second = spawnProc(TSX, [HERE], {
    env: { ...cleanEnv(), COTAL_I1263_WORKER: "1", COTAL_I1263_ROOT: seqRoot, COTAL_I1263_SPACE: SPACE, COTAL_I1263_SERVER: SERVER, COTAL_I1263_BARRIER: seqBarrier },
    stdio: ["ignore", "pipe", "pipe"],
  });
  teardownOnSignal(second);
  kids.push(second);
  let stderr = "";
  second.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
  const seqReport = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => settle(() => reject(new Error("the sequential second start did not report"))), 25_000);
    let buf = "";
    second.stdout?.on("data", (c: Buffer) => {
      buf += c.toString();
      // Only a complete line is a report; a chunk can end inside one.
      const line = buf.split("\n").slice(0, -1).find((l) => l.startsWith("{"));
      if (!line) return;
      settle(() => {
        try {
          const report = JSON.parse(line) as { ok?: unknown; error?: unknown };
          if (typeof report.ok !== "boolean" || (report.ok === false && typeof report.error !== "string")) throw new Error(`malformed report: ${line}`);
          resolve(report as { ok: boolean; error?: string });
        } catch (e) { reject(e); }
      });
    });
    second.once("error", (e) => settle(() => reject(e)));
    second.once("exit", (code, signal) => settle(() => reject(new Error(`the sequential second start exited before reporting (code ${code}, signal ${signal}): ${stderr.slice(-2000)}`))));
  }).finally(() => killAndAwaitExit(second, "SIGKILL"));
  const seqErr = seqReport.ok ? "" : seqReport.error ?? "";
  check("sequential second start REFUSES with already-serves (fence after identity exists)",
    /already serves space/.test(seqErr), seqErr);
  check("sequential pair shares the persisted identity",
    loadManagerInstanceIdentity(seqRoot, SPACE)?.instanceId === firstId);
  await first.stop({ withAgents: true }).catch(() => {});

  let raced = 0;
  let missingRefuse = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const root = mkdtempSync(join(tmpdir(), "cotal-i1263-race-"));
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
    recordMesh({ space: SPACE, server: SERVER, root, mode: "open", ts: new Date().toISOString() });
    const barrier = join(root, "go");
    const workers: ChildProcess[] = [];
    const parsed: Array<{ ok: boolean; pid: number; instanceId?: string; error?: string }> = [];
    const ambientEnv = cleanEnv();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("workers did not report")), 25_000);
      for (let i = 0; i < N; i++) {
        const child = spawnProc(TSX, [HERE], {
          env: {
            ...ambientEnv,
            COTAL_I1263_WORKER: "1",
            COTAL_I1263_ROOT: root,
            COTAL_I1263_SPACE: SPACE,
            COTAL_I1263_SERVER: SERVER,
            COTAL_I1263_BARRIER: barrier,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        workers.push(child);
        kids.push(child);
        let buf = "";
        let reported = false;
        child.stdout?.on("data", (c: Buffer) => {
          if (reported) return;
          buf += c.toString();
          const line = buf.trim().split("\n").find((l) => l.startsWith("{"));
          if (!line) return;
          try { parsed.push(JSON.parse(line)); } catch { return; }
          reported = true;
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          if (parsed.length >= N) { clearTimeout(timer); resolve(); }
        });
      }
      writeFileSync(barrier, "go");
    });
    for (const w of workers) {
      try { w.kill("SIGKILL"); } catch { /* done */ }
    }
    const started = parsed.filter((p) => p.ok);
    const refused = parsed.filter((p) => !p.ok);
    const unique = new Set(started.map((p) => p.instanceId).filter(Boolean));
    const fileId = loadManagerInstanceIdentity(root, SPACE)?.instanceId;
    if (unique.size !== 1 || fileId === undefined || !unique.has(fileId)) {
      raced++;
      console.log(`  ✗ FAIL: round ${r} started=${started.length} unique=${unique.size} file=${fileId}`, parsed);
    }
    if (started.length !== 1 || refused.length < 1 || refused.some((p) => !/already serves space/.test(p.error ?? ""))) {
      missingRefuse++;
      console.log(`  ✗ FAIL: round ${r} refusal path`, { started: started.length, refused: refused.map((p) => p.error) });
    }
  }
  check(`N=${N} concurrent Manager.start over ${ROUNDS} rounds mint exactly one identity`, raced === 0, { raced });
  check("losers refuse with already-serves (adopt then lease CAS)", missingRefuse === 0, { missingRefuse });
} finally {
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
  rmSync(home, { recursive: true, force: true });
}

console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
console.log(`\n${fail === 0 ? "MANAGER FRESH-ROOT IDENTITY SMOKE OK" : "MANAGER FRESH-ROOT IDENTITY SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
