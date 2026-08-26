/**
 * R1 store-shape + supervised-reader smoke (SPEC 13.12) — the panel-RC corrective probes for the
 * two branches the initial cut asserted but never executed:
 *
 *  BLOCKER 3 (store binding): the shape proof must bind the stream to the ACTUAL KV bucket, not
 *  merely a name — exactly the one `$KV.<bucket>.>` subject (an extra captured subject would put
 *  foreign bodies inside every body-selected MSG.GET grant, breaking the metadata-only residual)
 *  and durable file storage. Probed BOTH ways: `assertAuthorityStreamShape` directly against
 *  poisoned configs (fact-3's exact counterexample: extra subject + memory storage), and
 *  `ensureAuthorityStores` against a pre-created DRIFTED stream (create-or-verify must reject it).
 *
 *  BLOCKER 1 (fail-closed reader): a renewal-mint failure must down the supervised reader NOW
 *  (connects deny immediately, not at the old credential's eventual expiry), and a disconnect must
 *  leave the reader UNPROVED until the rebind shape proof re-runs — the every-(re)bind gate,
 *  driven here by a real broker bounce.
 *
 * Run: pnpm smoke:shape-supervisor:auth   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { createSpaceAuth, ensureAuthorityStores, epAuthBucket, isReachable, serverConfig } from "@cotal-ai/core";
import { Kvm } from "@nats-io/kv";
import { assertAuthorityStreamShape, type AuthorityStreamCfg } from "../src/lifecycle-registry.js";
import { openAuthorityClient, openSupervisedConnectReader } from "../src/authority-client.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
function throws(name: string, fn: () => void, needle?: string) {
  try { fn(); check(`${name} (expected throw)`, false); }
  catch (e) { const m = e instanceof Error ? e.message : String(e); check(needle && !m.includes(needle) ? `${name} (wrong reason: ${m})` : name, !needle || m.includes(needle)); }
}
async function rejectsAsync(name: string, fn: () => Promise<unknown>, needle?: string) {
  try { await fn(); check(`${name} (expected rejection)`, false); }
  catch (e) { const m = e instanceof Error ? e.message : String(e); check(needle && !m.includes(needle) ? `${name} (wrong reason: ${m})` : name, !needle || m.includes(needle)); }
}
function throwsSync(fn: () => void): boolean { try { fn(); return false; } catch { return true; } }

const space = `shapesup-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const conf = join(tmp, "server.conf");
writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
let srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
// Reassigned at the bounce below, so ownership is reassigned with it. Holding the FIRST handle
// past the respawn would leave ownership pinned to a dead pid while the live broker was unowned,
// which reads as handled and is worse than not owning it at all.
let releaseBroker = teardownOnSignal(srv, tmp);

const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};
const bucket = epAuthBucket(space);
const good: AuthorityStreamCfg = { subjects: [`$KV.${bucket}.>`], storage: "file", retention: "limits", allow_direct: false };

let reader: Awaited<ReturnType<typeof openSupervisedConnectReader>> | undefined;
let failReader: Awaited<ReturnType<typeof openSupervisedConnectReader>> | undefined;
let driftWriter: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  // ---- BLOCKER 3a: direct shape-assert drift probes (fact-3's counterexample) ----
  check("the exact-subject + file config PASSES the shape proof", !throwsSync(() => assertAuthorityStreamShape(good, bucket)));
  throws("an EXTRA captured subject is rejected (body-selected reads would leak foreign bytes)",
    () => assertAuthorityStreamShape({ ...good, subjects: [`$KV.${bucket}.>`, "secret.>"] }, bucket), "subject");
  throws("MEMORY storage is rejected (a non-durable authority store forgets fences on restart)",
    () => assertAuthorityStreamShape({ ...good, storage: "memory" }, bucket), "storage");
  throws("a MISSING subjects field is rejected (an unproved store never serves)",
    () => assertAuthorityStreamShape({ storage: "file", retention: "limits" }, bucket), "subject");
  throws("a WRONG-bucket subject is rejected", () => assertAuthorityStreamShape({ ...good, subjects: ["$KV.other.>"] }, bucket), "subject");

  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  // ---- BLOCKER 3b: ensureAuthorityStores rejects a pre-created DRIFTED auth stream ----
  driftWriter = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:drift:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  const jsm = await jetstreamManager(driftWriter.nc);
  // A stream wearing the auth bucket's KV_ name but capturing an EXTRA subject on memory storage.
  await jsm.streams.add({ name: `KV_${bucket}`, subjects: [`$KV.${bucket}.>`, "secret.>"], storage: "memory" as never });
  await rejectsAsync("ensureAuthorityStores REJECTS a pre-created drifted auth stream (extra subject + memory)",
    () => ensureAuthorityStores(jsm, new Kvm(driftWriter!.nc), space), "13.12");
  // Clean the poisoned stream so the reader below binds a REAL store (provisioned by the plane path).
  await jsm.streams.delete(`KV_${bucket}`);
  await ensureAuthorityStores(jsm, new Kvm(driftWriter.nc), space);
  check("ensureAuthorityStores PROVISIONS clean authority stores on a virgin space", true);

  // ---- BLOCKER 1a: renewal failure downs the reader NOW ----
  failReader = await openSupervisedConnectReader({ server: SERVERS, space, dataAccount, log: quiet, probeRenewal: { intervalMs: 200, fail: true } });
  check("a freshly-bound supervised reader serves current()", (() => { try { failReader!.current(); return true; } catch { return false; } })());
  await wait(500); // let a forced-fail renewal tick fire
  check("BLOCKER 1a: current() DENIES immediately after a forced renewal failure (not at eventual expiry)",
    throwsSync(() => failReader!.current()));
  await failReader.close();
  failReader = undefined;

  // ---- BLOCKER 1b: disconnect leaves the reader unproved until the rebind shape proof re-runs ----
  reader = await openSupervisedConnectReader({ server: SERVERS, space, dataAccount, log: quiet });
  check("the supervised reader serves current() while connected", (() => { try { reader!.current(); return true; } catch { return false; } })());
  // Bounce the broker on the SAME port + store dir so the reader reconnects to a live JetStream.
  srv.kill();
  await awaitExit(srv);
  const downDenied = await (async () => { for (let i = 0; i < 25; i++) { if (throwsSync(() => reader!.current())) return true; await wait(100); } return false; })();
  check("BLOCKER 1b: current() DENIES while the connection is down (unproved between binds)", downDenied);
  releaseBroker();
  srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(srv, tmp);
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) break; await wait(200); }
  const reproved = await (async () => { for (let i = 0; i < 60; i++) { try { reader!.current(); return true; } catch { await wait(250); } } return false; })();
  check("BLOCKER 1b: current() SERVES again only after the rebind shape proof re-runs", reproved);

  console.log(`\nSHAPE-SUPERVISOR SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await reader?.close().catch(() => {});
  await failReader?.close().catch(() => {});
  await driftWriter?.close().catch(() => {});
  srv.kill();
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
