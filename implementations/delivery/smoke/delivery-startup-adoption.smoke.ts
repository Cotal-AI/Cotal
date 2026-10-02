/**
 * #2304: a delivery daemon must not exit when the renewal owner's adoption lands during its own
 * start-up. The lease flips ready (and `ensureDelivery` releases the manager) before the membership
 * feed, the timer writer and the lease watch are up; a manager's boot-time `reloadCreds` landing in
 * that window schedules the resident swap (`nc.reconnect()`) underneath the start-up awaits still
 * pending.
 *
 * Each trial starts a REAL `cotal deliver` on a fresh lease, waits for its "delivery daemon up" line
 * (printed right after the ready flip), waits a swept offset, then plays the manager's boot pass:
 * re-sign delivery.creds + membership-rw.creds for their existing nkeys and request `reloadCreds`
 * with the expected fingerprints, exactly as `Manager.renewDaemonCreds` does. The daemon must still
 * be alive, and must not have logged a start-up failure, after a settle window.
 *
 * Deaths are a race (measured on the unfixed daemon: 1-2 per 20 trials near offset 0, none past
 * ~40 ms), so the death cell alone can pass on an unfixed tree. The reply cells are deterministic:
 * an adoption that lands before start-up finished is refused as not started with nothing adopted,
 * the next pass on that same daemon then adopts, and one that lands after start-up still adopts.
 *
 * NOTE: runs the BUILT dist — `pnpm build` first.
 * Run: pnpm exec tsx implementations/delivery/smoke/delivery-startup-adoption.smoke.ts
 *      (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  credsFingerprint,
  isReachable,
  createSpaceAuth,
  mintConnectionEvictorCreds,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { spaceMaterialDir } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const cotalJs = join(repoRoot, "bin", "dist", "cotal.js");
// Offsets after the ready line. The unfixed daemon died only near 0 ms (the swap must land while the
// lease watch's consumer create is in flight, ~330 ms after the ready flip), so the sweep is dense
// there; the late offsets land after start-up and must adopt. The manager's own boot adoption was
// measured ~450 ms after the responder bound.
const OFFSETS_MS = [0, 0, 0, 10, 20, 30, 50, 100, 450, 800];
const ROUNDS = Number(process.env.STARTUP_ADOPTION_ROUNDS ?? 2);
const NOT_STARTED = "has not finished starting";
const SETTLE_MS = 6_000;
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const until = async (cond: () => boolean, timeoutMs: number, stepMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};

const space = `dlv-startadopt-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const obsCreds = await mintMembershipObserverCreds(auth, newIdentity());
const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-dlv-startadopt-root-")));
const spaceDir = spaceMaterialDir(root, space);
mkdirSync(spaceDir, { recursive: true });
const credsPath = join(spaceDir, "delivery.creds");
const rwPath = join(spaceDir, "membership-rw.creds");

let daemon: ChildProcess | undefined;
let sup: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const dlvId = newIdentity();
  const rwId = newIdentity();
  writeFileSync(credsPath, await mintCreds(auth, dlvId, "delivery"), { mode: 0o600 });
  writeFileSync(rwPath, await mintCreds(auth, rwId, "membership-rw"), { mode: 0o600 });
  writeFileSync(join(spaceDir, "membership-observer.creds"), obsCreds, { mode: 0o600 });
  writeFileSync(join(spaceDir, "connection-evictor.creds"), evictorCreds, { mode: 0o600 });
  writeFileSync(join(spaceDir, "membership.json"), JSON.stringify({ accountId: auth.account.pub }), { mode: 0o600 });

  const supId = newIdentity();
  sup = new CotalEndpoint({
    space, servers: SERVERS,
    creds: await mintCreds(auth, supId, "supervisor"),
    card: { id: supId.id, name: "renewal-owner", kind: "endpoint" },
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  sup.on("error", () => {});
  await sup.start();

  const trials: { offset: number; died: boolean; startupFailed: boolean; reply: string; retry?: string }[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const offset of OFFSETS_MS) {
      let output = "";
      let exited = false;
      daemon = spawn(process.execPath, [cotalJs, "deliver", "--space", space, "--server", SERVERS, "--creds", credsPath], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, XDG_CONFIG_HOME: join(dir, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1" },
      });
      daemon.stdout!.on("data", (d: Buffer) => { output += d.toString(); });
      daemon.stderr!.on("data", (d: Buffer) => { output += d.toString(); });
      daemon.on("exit", () => { exited = true; });
      if (!(await until(() => output.includes("delivery daemon up") || exited, 20_000)) || exited)
        throw new Error(`trial daemon never came up (round ${round}, offset ${offset}ms, ${exited ? "exited" : "still running"}):\n${output.slice(-1500)}`);
      await wait(offset);

      // The manager's boot pass: re-sign both files for their existing nkeys, then reloadCreds with
      // the expected generation per component.
      const dlv = await mintCreds(auth, dlvId, "delivery");
      const rw = await mintCreds(auth, rwId, "membership-rw");
      writeFileSync(credsPath, dlv, { mode: 0o600 });
      writeFileSync(rwPath, rw, { mode: 0o600 });
      let reply: string;
      try {
        const r = await sup.requestDeliveryAdmin("reloadCreds", { expected: { delivery: credsFingerprint(dlv), membership: credsFingerprint(rw) } }, 15_000);
        reply = r.ok ? "ok" : `refused: ${r.error}`;
      } catch (e) {
        reply = `no reply: ${(e as Error).message}`;
      }
      await until(() => exited, SETTLE_MS, 50);
      const startupFailed = output.includes("start-up failed");
      // The refusal promises that the next renewal pass adopts: replay the pass on this same daemon
      // once start-up has settled, with a fresh generation, as the manager's next tick would.
      let retry: string | undefined;
      if (!exited && reply.includes(NOT_STARTED)) {
        const dlv2 = await mintCreds(auth, dlvId, "delivery");
        const rw2 = await mintCreds(auth, rwId, "membership-rw");
        writeFileSync(credsPath, dlv2, { mode: 0o600 });
        writeFileSync(rwPath, rw2, { mode: 0o600 });
        try {
          const r = await sup.requestDeliveryAdmin("reloadCreds", { expected: { delivery: credsFingerprint(dlv2), membership: credsFingerprint(rw2) } }, 15_000);
          retry = r.ok ? "ok" : `refused: ${r.error}`;
        } catch (e) {
          retry = `no reply: ${(e as Error).message}`;
        }
      }
      trials.push({ offset, died: exited, startupFailed, reply, ...(retry !== undefined ? { retry } : {}) });
      console.log(`  · round ${round} offset ${offset}ms: ${exited ? "DIED" : "alive"}${startupFailed ? " (start-up failed)" : ""}; reload ${reply}${retry !== undefined ? `; next pass ${retry}` : ""}`);
      if (exited || startupFailed) console.log(`    daemon tail:\n${output.slice(-1200)}`);

      if (!exited) await killAndAwaitExit(daemon, "SIGTERM");
      daemon = undefined;
      // The graceful stop releases the lease; give the bucket a beat before the next acquire.
      await wait(300);
    }
  }

  const dead = trials.filter((t) => t.died || t.startupFailed);
  check(`${trials.length} trials ran (${OFFSETS_MS.length} offsets x ${ROUNDS} rounds)`, trials.length === OFFSETS_MS.length * ROUNDS);
  check(`no daemon exited or failed start-up when the boot adoption landed during start-up (${dead.length}/${trials.length})`, dead.length === 0);
  const early = trials.filter((t) => t.reply.includes(NOT_STARTED));
  check(`an adoption landing before start-up finished was refused as not started, nothing adopted (${early.length}/${trials.length})`, early.length > 0);
  const other = trials.filter((t) => t.reply !== "ok" && !t.reply.includes(NOT_STARTED));
  check(`every reply was a full adoption or the not-started refusal, never a partial one`, other.length === 0, other.map((t) => `${t.offset}ms: ${t.reply}`));
  const retried = early.filter((t) => t.retry !== undefined);
  check(`the next renewal pass on the same daemon adopted every refused generation (${retried.filter((t) => t.retry === "ok").length}/${early.length})`, early.length > 0 && retried.length === early.length && retried.every((t) => t.retry === "ok"), retried.filter((t) => t.retry !== "ok").map((t) => `${t.offset}ms: ${t.retry}`));
  check(`an adoption landing after start-up still adopted (${trials.filter((t) => t.reply === "ok").length}/${trials.length})`, trials.some((t) => t.reply === "ok"));

  console.log(`\nDELIVERY-STARTUP-ADOPTION SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await sup?.stop(); } catch { /* draining */ }
  try { daemon?.kill("SIGKILL"); } catch { /* gone */ }
  await killAndAwaitExit(srv, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  releaseBroker();
}
