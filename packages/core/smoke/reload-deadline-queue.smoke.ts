/**
 * RELOAD DEADLINE / QUEUE-WAIT (W3 3a, freelance HIGH re-round): the daemon-side reload deadline must
 * be ABSOLUTE from the caller's entry, INCLUDING the single-flight queue wait — not a fresh budget
 * granted when the queued transaction finally starts.
 *
 * The bug: `adoptFreshCreds` computed its 12s deadline when its callback STARTED. So if the passive 75%
 * timer is already in a hung-store transaction (its own 12s), an explicit `reloadCreds` queued behind
 * it waits ~12s, then receives a FRESH 12s and can preflight/commit/swap at ~24s — long after the
 * manager's 15s request bound elapsed and it recorded "no responder". The fix captures the deadline at
 * `reloadCreds`/`renewCredsOnTimer` entry (before enqueue) and fences before any source I/O.
 *
 * The proof, on a real broker: an endpoint connects on a LONG-TTL cred (so the passive timer never
 * fires during the test), then a creds SOURCE that HANGS for every renewal read. Two `reloadCreds()`
 * are fired in one tick: [A] enters the single-flight and hangs on the source until its deadline; [B]
 * queues behind A. With the fix, B's deadline was captured at entry, so when A settles at ~12s B fences
 * IMMEDIATELY ("deadline elapsed while queued") at ~12s total — NOT the ~24s a fresh budget would give.
 * B finishing under the manager's 15s bound (and with the queue message, not the source-timeout one) is
 * the regression signal.
 *
 * Run: pnpm smoke:reload-deadline-queue   (needs `nats-server` on PATH; local-only; ~15s)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  serverConfig, setupSpaceStreams,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MANAGER_BOUND_MS = 15_000; // manager's requestDeliveryAdmin("reloadCreds") timeout
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `reload-dq-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-reload-dq-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const sup = newIdentity();
  let reads = 0;
  // First read (initial connect) returns a LONG-TTL cred so the passive 75% timer won't fire in the
  // test window and add a third contender. Every RENEWAL read hangs (a fresh never-resolving-in-test
  // promise), standing in for a hung SecretStore.
  const source = (): Promise<string> => {
    reads++;
    if (reads === 1) return mintCreds(auth, sup, "supervisor", { expiresInSeconds: 600 });
    return new Promise<string>((resolve) => { setTimeout(() => resolve(""), 30_000).unref?.(); });
  };
  const ep = new CotalEndpoint({
    space, servers: SERVERS, creds: source,
    card: { id: sup.id, name: "mgr", kind: "endpoint" },
    consume: false, lifecycleUid: mintLifecycleUid(),
    watchChannels: false, watchPresence: false, registerPresence: false,
  });
  ep.on("error", () => {});
  await ep.start();
  check("endpoint connects on the initial (long-TTL) cred", reads === 1, reads);

  // Fire both in ONE tick: A enqueues first (its .then registers first in the single-flight chain), B
  // queues strictly behind it.
  const t0 = Date.now();
  const rA = ep.reloadCreds().then(() => ({ ok: true, ms: Date.now() - t0, msg: "" }), (e: Error) => ({ ok: false, ms: Date.now() - t0, msg: e.message }));
  const rB = ep.reloadCreds().then(() => ({ ok: true, ms: Date.now() - t0, msg: "" }), (e: Error) => ({ ok: false, ms: Date.now() - t0, msg: e.message }));
  const [a, b] = await Promise.all([rA, rB]);

  check("A (first in the single-flight) fails at its source deadline, nothing adopted", !a.ok && /did not return before the daemon deadline/i.test(a.msg), a);
  check("B (queued behind A) also fails - nothing adopted", !b.ok, b);
  // B fails with one of the two EXPECTED structured messages, never a stray error. Which one is a
  // sub-ms race: B's entry deadline is captured microseconds after A's (same tick), so when A rejects
  // at ~12s and B dequeues, if `now > deadline` the pre-I/O fence fires ("elapsed while queued"),
  // else B falls through to `withDeadline(source, ~0ms)` and rejects with the source-timeout. BOTH are
  // the SAME correct outcome (B bounded by its entry deadline, nothing adopted) — the message is not
  // the discriminator, the TIMING bound below is. Asserting on the message alone would flake ~1/6.
  check("B fails structured (entry fence OR ~0-budget source timeout), not a stray error", /elapsed while queued|did not return before the daemon deadline/i.test(b.msg), b);
  // THE load-bearing assertion: B finished within the manager's request bound. The bug gave B a fresh
  // 12s AFTER the ~12s queue wait (~24s); the fix bounds B by the same window it entered with (~12s).
  // This is the real fresh-budget discriminator and never flaked (~12001ms across runs).
  check("B finished within the manager's 15s request bound (no fresh budget after the queue wait)", b.ms < MANAGER_BOUND_MS, `${b.ms}ms`);
  check("B waited behind A rather than returning instantly (it really was queued)", b.ms >= 10_000, `${b.ms}ms`);

  await ep.stop();
  console.log(`\n${fail ? "✗" : "✓"} RELOAD DEADLINE-QUEUE REGRESSION ${pass}/${pass + fail}`);
  process.exitCode = fail ? 1 : 0;
} finally {
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  await wait(200);
}
process.exit(fail ? 1 : 0);
