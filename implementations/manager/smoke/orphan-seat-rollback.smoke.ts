/**
 * A spawn that LAUNCHED its seat and then threw is rolled back by the manager that launched it,
 * and the rollback proves the seat process gone before it retires the lifecycle.
 *
 * The two sibling suites both cover a manager that DIED: `orphan-seat-reap` kills it after a
 * completed spawn, `orphan-seat-spawn-window` kills it inside `runtime.spawn`. Neither reaches
 * this path, because in both the reap is driven by a SUCCESSOR reading the slot row. Here the
 * manager survives its own failure: the throw lands in `startAgent`'s catch and the `finally`
 * drives the orphan rollback in-process, where the handle exists only in a local that is already
 * out of scope. The slot row holds the reserved reference, but `reapOrphanSeat` reads the object
 * the rollback was handed, never the row, so the reference has to ride the rollback object too.
 * Without it the rollback retired the lifecycle and freed the alias over a running seat.
 *
 * The throw is injected at `onLaunched`, the production progress callback the spawn-as-action
 * seam passes into `startAgent`. It fires between the launch and the slot activation CAS, so a
 * throw there reaches the same catch and the same rollback as a CAS that refuses the slot. The
 * CAS refusal itself needs a second writer to change the row mid-spawn, and every writer that
 * does so in production is a successor terminal that reaps the seat itself, which is the one
 * thing this suite has to rule out.
 *
 * Run: pnpm smoke:orphan-seat-rollback
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, createSpaceAuth, evictDeniedPrincipalWithCreds, isReachable, mintConnectionEvictorCreds, mintCreds, mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { readRecord, recordPath } from "@cotal-ai/seat";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") {
  console.log(`ORPHAN-SEAT ROLLBACK COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
  process.exit(0);
}

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
const state = (pid: number): string => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] ?? "unknown";
  } catch { return "gone"; }
};
const live = (pid: number): boolean => state(pid) !== "gone" && state(pid) !== "Z";
const stopGroup = (pid?: number) => { if (!pid) return; try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } };
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../.."); const host = join(here, "_orphan-reap-host.ts"); const tsx = join(repo, "node_modules", ".bin", "tsx");
const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];

const alias = "rollbackworker";
const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `rollback-${randomUUID().slice(0, 8)}`; const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws"); const seatRoot = join(dir, "seats"); mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth); writeFileSync(join(root, ".cotal", "agents", `${alias}.md`), `---\nname: ${alias}\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n`); writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir); let daemon: CotalEndpoint | undefined; let manager: ChildProcess | undefined; const pids: number[] = [];
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50); await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const did = newIdentity(); daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, did, "delivery"), card: { id: did.id, name: "delivery", role: "delivery", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false }); daemon.on("error", () => {}); await daemon.start(); await daemon.startPlane3(async () => undefined, { evictPrincipal: async (principal) => evictDeniedPrincipalWithCreds({ servers, observerCreds, evictorCreds, accountId: auth.account.pub, principal, options: { maxVerifyRounds: 12 } }), reloadStoreIdentity: () => ({ kind: "fs", root: resolve(root) }) });

  const marker = join(dir, "launched.json");
  let out = "", err = "";
  manager = spawn(tsx, [host], { cwd: repo, env: { ...ambientEnv, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, REPRO_OBSERVER_CREDS: observerCreds, REPRO_EVICTOR_CREDS: evictorCreds, REPRO_ACCOUNT_ID: auth.account.pub, REPRO_SPAWN: "1", REPRO_ALIAS: alias, REPRO_THROW_AFTER_LAUNCH: "1", REPRO_MARKER: marker, COTAL_SEAT_ROOT: seatRoot, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  manager.stdout?.on("data", (b) => out += String(b)); manager.stderr?.on("data", (b) => err += String(b));
  if (!(await until(() => existsSync(marker) || manager!.exitCode !== null, 120_000))) throw new Error(`manager never reached the launch hook: ${err}`);
  if (!existsSync(marker)) throw new Error(`manager exited ${manager.exitCode} before launching a seat: ${err}`);

  // The hook holds the manager between the launch and the throw, so the seat is observable here
  // exactly as the rollback will find it: custodian and child running, slot never activated.
  const seats = readdirSync(seatRoot).filter((id) => existsSync(recordPath(seatRoot, id)));
  if (seats.length !== 1) throw new Error(`expected one seat record under the custody root, found ${seats.length}: ${seats.join(", ")}`);
  const record = readRecord(recordPath(seatRoot, seats[0]!));
  pids.push(record.custodianPid, record.childPid);
  check("instrument: the spawn launched a real seat before it threw", live(record.custodianPid) && live(record.childPid), { custodian: state(record.custodianPid), child: state(record.childPid) });

  writeFileSync(`${marker}.go`, "release\n");
  const refused = await until(() => out.includes("REPRO_SPAWN "), 120_000);
  const reply = refused ? JSON.parse(out.split("\n").find((l) => l.startsWith("REPRO_SPAWN "))!.slice("REPRO_SPAWN ".length)) as { reply: { ok: boolean; error?: string } } : undefined;
  check("the spawn fails on the throw that followed its launch", reply?.reply.ok === false && /the spawn threw after the seat launched/.test(reply.reply.error ?? ""), reply ?? err);

  const reaped = await until(() => new RegExp(`static retirement ${alias}: orphan seat process custodian \\d+ (signalled|gone), child \\d+ (signalled|gone)`).test(err), 60_000);
  check("the rollback reaps the launched seat by the reference the spawn reserved", reaped && await until(() => !live(record.custodianPid) && !live(record.childPid), 30_000), { stderr: err.split("\n").filter((l) => l.includes(`static retirement ${alias}`)).join("\n"), custodian: state(record.custodianPid), child: state(record.childPid) });
  // The terminal barrier revokes and evicts the seat's broker principal, then runs its cleanup
  // step, and the process reap is the first thing in that step. A reap that refused would leave
  // the cleanup marker unset and the whole terminal failing, which is the `(<id>):` error form.
  const evictedAt = err.indexOf(`static retirement ${alias}: verified orphan seat principal gone:`);
  const reapedAt = err.search(new RegExp(`static retirement ${alias}: orphan seat process`));
  check("the terminal evicts the seat's broker principal, reaps its process next, and reports no failure", evictedAt >= 0 && reapedAt > evictedAt && !new RegExp(`static retirement ${alias} \\(`).test(err), { evictedAt, reapedAt, lines: err.split("\n").filter((l) => l.includes("static retirement")).join("\n") });

  const EXPECTED = 4;
  if (pass + fail !== EXPECTED) throw new Error(`expected ${EXPECTED} cells, ran ${pass + fail}; a cell was added or silently skipped`);
  console.log(`\nORPHAN-SEAT ROLLBACK SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} finally {
  if (manager && manager.exitCode === null) { const exited = new Promise<void>((res) => manager!.once("exit", () => res())); stopGroup(manager.pid); await exited; }
  for (const pid of pids) stopGroup(pid);
  await daemon?.stop().catch(() => {});
  broker.kill("SIGKILL");
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
