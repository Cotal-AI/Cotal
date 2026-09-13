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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { probeConnect } from "@cotal-ai/core";
import { loadManagerInstanceIdentity, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

const HERE = fileURLToPath(import.meta.url);
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
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-i1263-js-"))], { stdio: "ignore" });
  kids.push(broker);
  for (let i = 0; i < 60; i++) { if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break; await wait(120); }

  const seqRoot = mkdtempSync(join(tmpdir(), "cotal-i1263-seq-"));
  mkdirSync(join(seqRoot, ".cotal", "agents"), { recursive: true });
  recordMesh({ space: SPACE, server: SERVER, root: seqRoot, mode: "open", ts: new Date().toISOString() });
  const first = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: seqRoot });
  await first.start();
  const firstId = (first as unknown as { managerInstanceId: string }).managerInstanceId;
  let seqErr = "";
  const second = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: seqRoot });
  try { await second.start(); } catch (e) { seqErr = (e as Error).message; }
  check("sequential second start REFUSES with already-serves (fence after identity exists)",
    /already serves space/.test(seqErr), seqErr);
  check("sequential pair shares the persisted identity",
    loadManagerInstanceIdentity(seqRoot, SPACE)?.instanceId === firstId);
  await second.stop({ withAgents: true }).catch(() => {});
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
    const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];
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
}

console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
console.log(`\n${fail === 0 ? "MANAGER FRESH-ROOT IDENTITY SMOKE OK" : "MANAGER FRESH-ROOT IDENTITY SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
