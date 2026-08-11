/**
 * Standing renewal smoke (D5 slice 5, class 1): a bounded standing cred rides the endpoint's creds
 * SOURCE and survives its own JWT expiry on a real auth broker — the broker closes the connection at
 * `exp`, the automatic reconnect presents the freshest self-reminted cred, and the endpoint keeps
 * working. Also pins the seam's fail-loud edges: a source requires an explicit pinned identity, a
 * renewal may never swap the nkey, and an unbounded cred from a source is a mismatch, not a keeper.
 *
 * Run: pnpm smoke:standing-renewal   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  serverConfig,
  setupSpaceStreams,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs = 10000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const space = `renewal-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-renewal-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });

  // ── The renewal loop itself: a supervisor-style self-remint source with a seconds-scale TTL.
  // Lifecycle under test: connect on cred#1 (exp=4s) → refreshCreds at 75% (~3s) mints cred#2 →
  // broker closes the connection at cred#1's exp → automatic reconnect presents cred#2 → alive.
  const TTL = 4;
  const sup = newIdentity();
  let mints = 0;
  const source = () => { mints++; return mintCreds(auth, sup, "supervisor", { expiresInSeconds: TTL }); };
  const errors: string[] = [];
  const ep = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: source,
    card: { id: sup.id, name: "mgr", kind: "endpoint" },
    consume: false,
    lifecycleUid: mintLifecycleUid(), // authed + presence-registering: lifecycle-keyed (fail-before-presence gate)
    watchChannels: false,
    watchPresence: false,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  ep.on("error", (e: Error) => { errors.push(e.message); console.error("  ! mgr:", e.message); });
  const bornAt = Date.now();
  await ep.start();
  check("creds-source endpoint connects (initial fetch before first connect)", mints === 1, mints);

  check("renewal fires ahead of expiry (75% of lifetime)", await until(() => mints >= 2, TTL * 1000), mints);
  const renewedAt = Date.now() - bornAt;
  check("renewal fired before the first cred's exp", renewedAt < TTL * 1000, `${renewedAt}ms`);

  // Cross the original exp, give the broker's expiry-close + the client's reconnect time to land,
  // then prove the endpoint still works with a real round-trip (a presence write over the wire).
  await wait(bornAt + TTL * 1000 + 500 - Date.now());
  let aliveAfterExp = false;
  for (let i = 0; i < 40 && !aliveAfterExp; i++) {
    try { await ep.setActivity(`post-renewal-${i}`); aliveAfterExp = true; } catch { await wait(250); }
  }
  check("endpoint survives its first cred's expiry (round-trip after exp on the renewed cred)", aliveAfterExp);
  check("no renewal errors on the happy path", errors.length === 0, errors);
  await ep.stop();

  // ── Fail-loud edges.
  const other = newIdentity();
  let threw = "";
  try {
    new CotalEndpoint({ space, servers: SERVERS, creds: source, card: { name: "anon", kind: "endpoint" } });
  } catch (e) { threw = (e as Error).message; }
  check("a creds source without an explicit card.id is refused at construction", threw.includes("card.id"), threw);

  threw = "";
  try {
    const swapped = new CotalEndpoint({
      space, servers: SERVERS,
      creds: () => mintCreds(auth, other, "supervisor", { expiresInSeconds: TTL }),
      card: { id: sup.id, name: "swapped", kind: "endpoint" },
      consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
    });
    await swapped.start();
    await swapped.stop();
  } catch (e) { threw = (e as Error).message; }
  check("a source returning a DIFFERENT identity fails loud at start (renewal may not swap the nkey)", threw.includes("may not swap"), threw);

  threw = "";
  try {
    const unbounded = new CotalEndpoint({
      space, servers: SERVERS,
      // teardown has NO matrix default TTL → an unbounded cred, which a renewal source must refuse.
      creds: () => mintCreds(auth, sup, "teardown", { lifecycleUid: mintLifecycleUid() }),
      card: { id: sup.id, name: "unbounded", kind: "endpoint" },
      consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
    });
    await unbounded.start();
    await unbounded.stop();
  } catch (e) { threw = (e as Error).message; }
  check("a source returning an UNBOUNDED cred fails loud (renewal seam requires bounded creds)", threw.includes("without a numeric exp"), threw);

  console.log(fail === 0 ? `\nSTANDING RENEWAL SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nSTANDING RENEWAL SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
