import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, createSpaceAuth, evictDeniedPrincipalWithCreds, isReachable, mintConnectionEvictorCreds, mintCreds, mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const freePort = (): Promise<number> => new Promise((res, rej) => { const s = createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (read()) return true; await wait(100); }
  return read();
};
const alive = (pid: number): boolean => {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.lastIndexOf(") ");
      if (after >= 0 && stat.slice(after + 2).startsWith("Z ")) return false;
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const stopGroup = (pid?: number) => { if (!pid) return; try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } };
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../.."); const host = join(here, "_orphan-seat-host.ts"); const tsx = join(repo, "node_modules", ".bin", "tsx");
const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `orphan817-${randomUUID().slice(0, 8)}`; const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws"); mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth); writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n"); writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir); let daemon: CotalEndpoint | undefined; const managers: ChildProcess[] = []; const seats: number[] = [];
async function startManager(tag: string, returnAtManager = false): Promise<{ child: ChildProcess; manager?: { managerPid: number; managerInstanceId: string }; ready?: { managerPid: number; managerInstanceId: string; seatPid: number; actor: string; lifecycleUid: string }; spawn?: { managerPid: number; managerInstanceId: string; reply: { ok: boolean; error?: string; data?: unknown }; managedNames: string[] }; stdout: () => string; stderr: () => string }> {
  const child = spawn(tsx, [host], { cwd: repo, env: { ...process.env, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" }, stdio: ["ignore", "pipe", "pipe"] }); managers.push(child); let out = "", err = ""; child.stdout?.on("data", (b) => out += String(b)); child.stderr?.on("data", (b) => err += String(b)); const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) { const readyLine = out.split("\n").find((x) => x.startsWith("REPRO_READY ")); if (readyLine) { const ready = JSON.parse(readyLine.slice("REPRO_READY ".length)); seats.push(ready.seatPid); return { child, ready, stdout: () => out, stderr: () => err }; } const spawnLine = out.split("\n").find((x) => x.startsWith("REPRO_SPAWN ")); if (spawnLine) return { child, spawn: JSON.parse(spawnLine.slice("REPRO_SPAWN ".length)), stdout: () => out, stderr: () => err }; const managerLine = out.split("\n").find((x) => x.startsWith("REPRO_MANAGER ")); if (managerLine && returnAtManager) return { child, manager: JSON.parse(managerLine.slice("REPRO_MANAGER ".length)), stdout: () => out, stderr: () => err }; if (child.exitCode !== null) throw new Error(`${tag} manager exited ${child.exitCode}: ${err}`); await wait(100); }
  throw new Error(`${tag} manager readiness timeout: ${err}`);
}
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50); await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const did = newIdentity(); daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, did, "delivery"), card: { id: did.id, name: "delivery", role: "delivery", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false }); daemon.on("error", () => {}); await daemon.start(); await daemon.startPlane3(async () => undefined, { evictPrincipal: async (principal) => evictDeniedPrincipalWithCreds({ servers, observerCreds, evictorCreds, accountId: auth.account.pub, principal }) });
  const first = await startManager("first"); if (!first.ready) throw new Error(`first manager refused: ${first.spawn?.reply.error}`);
  process.kill(first.ready.managerPid, "SIGKILL"); await new Promise((resolve) => first.child.once("exit", resolve));
  check("instrument: manager SIGKILL leaves the independently-owned seat live", alive(first.ready.seatPid), first.ready);
  await wait(20_000);
  const second = await startManager("successor", true);
  check("successor uses the same persisted logical manager instance", (second.manager ?? second.ready ?? second.spawn)?.managerInstanceId === first.ready.managerInstanceId, { first: first.ready, second: second.manager ?? second.ready ?? second.spawn });
  const predecessorGone = await until(() => !alive(first.ready!.seatPid), 45_000);
  check("successor verify-evicts the orphan before replacement can be admitted", predecessorGone, { stderr: second.stderr(), predecessorAlive: alive(first.ready.seatPid) });
  const spawnDeadline = Date.now() + 90_000;
  let replacement: { seatPid: number } | undefined;
  let refusal: unknown;
  while (Date.now() < spawnDeadline) {
    const readyLine = second.stdout().split("\n").find((x) => x.startsWith("REPRO_READY "));
    if (readyLine) { replacement = JSON.parse(readyLine.slice("REPRO_READY ".length)); seats.push(replacement!.seatPid); break; }
    const spawnLine = second.stdout().split("\n").find((x) => x.startsWith("REPRO_SPAWN "));
    if (spawnLine) { refusal = JSON.parse(spawnLine.slice("REPRO_SPAWN ".length)); break; }
    if (second.child.exitCode !== null) break;
    await wait(250);
  }
  check("replacement seat is live only after predecessor exit was proven", replacement !== undefined && alive(replacement.seatPid), replacement ?? refusal ?? second.stderr());
  console.log(`\nORPHAN-SEAT SUCCESSION SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} finally { for (const child of managers) if (child.exitCode === null) child.kill("SIGKILL"); for (const pid of seats) stopGroup(pid); await daemon?.stop().catch(() => {}); broker.kill("SIGKILL"); await wait(300); rmSync(dir, { recursive: true, force: true }); releaseBroker(); }
