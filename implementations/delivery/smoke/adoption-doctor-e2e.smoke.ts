/**
 * ADOPTION E2E, cross-process (W3 3a): the full product surface end-to-end, not simulation. A real
 * `cotal deliver` daemon + a real broker + the real manager renewal PRIMITIVES (remintDaemonCreds +
 * requestDeliveryAdmin + writeRenewalRecord, the exact sequence Manager.renewDaemonCreds wires) + the
 * packaged `cotal doctor auth` BINARY reading the record the real daemon's real reply produced.
 *
 *  HAPPY:   a trusted re-sign the daemon broker-ACCEPTS  → record ok:true  → `doctor auth` exit 0, "broker-accepted".
 *  REFUSED: a rogue (untrusted-operator, same nkey) delivery cred in the daemon's store, which the daemon's
 *           reload preflight REFUSES → record ok:false → `doctor auth` exit 1, "refused by the broker" — the
 *           ORIGINAL false-green (daemon never re-authenticated, doctor said healthy), now caught.
 *  --fix:   `doctor auth --fix` on the refused state does NOT erase it to green (a local re-sign is no proof).
 *
 * NOT covered here (3b): the membership feed's conn-B PASSIVE source re-read on an incidental reconnect.
 * This exercises the EXPLICIT reload path for both components + the packaged doctor binary.
 *
 * NOTE: runs the BUILT dist — `pnpm build` first.
 * Run: pnpm smoke:adoption-doctor-e2e   (needs `nats-server` on PATH; local-only; ~40s)
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, createSpaceAuth, credsFingerprint, isReachable, mintConnectionEvictorCreds, mintCreds,
  mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams,
} from "@cotal-ai/core";
import { authDir, DELIVERY_CREDS_KEY, remintDaemonCreds, saveSpaceAuth, writeRenewalRecord } from "@cotal-ai/workspace";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const cotalJs = join(repoRoot, "bin", "dist", "cotal.js");
let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };
const until = async (c: () => boolean, ms: number, step = 200) => { const d = Date.now() + ms; while (!c() && Date.now() < d) await wait(step); return c(); };

const runDoctor = (root: string, fix = false) => {
  const r = spawnSync(process.execPath, [cotalJs, "doctor", "auth", ...(fix ? ["--fix"] : [])], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
// The admin responder has a brief re-arm window after boot / after a swap; retry on no-responders.
async function adminReq(ep: CotalEndpoint, op: string, args: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  let last: Error | undefined;
  for (let i = 0; i < 12; i++) { try { return await ep.requestDeliveryAdmin(op, args, 15_000); } catch (e) { last = e as Error; await wait(500); } }
  throw last ?? new Error("adminReq: no attempts ran");
}

const cleanups: Array<() => void> = [];
try {
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const space = `e2e-doc-${randomUUID().slice(0, 8)}`;
  const auth = await createSpaceAuth(space);
  const rogue = await createSpaceAuth(space);
  const obs = await mintMembershipObserverCreds(auth, newIdentity());
  const evictor = await mintConnectionEvictorCreds(auth, newIdentity());

  const dir = mkdtempSync(join(tmpdir(), "cotal-e2e-doc-"));
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port, storeDir: join(dir, "js") }));
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  cleanups.push(() => { srv.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) { up = true; break; } await wait(200); }
  if (!up) throw new Error("nats-server did not come up");
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root = mkdtempSync(join(tmpdir(), "cotal-e2e-doc-root-"));
  mkdirSync(join(root, ".cotal", "auth"), { recursive: true });
  saveSpaceAuth(authDir(root), auth);
  const dlvId = newIdentity();
  writeFileSync(join(root, ".cotal", "delivery.creds"), await mintCreds(auth, dlvId, "delivery", { expiresInSeconds: 300 }), { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership-rw.creds"), await mintCreds(auth, newIdentity(), "membership-rw", { expiresInSeconds: 600 }), { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership-observer.creds"), obs, { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "connection-evictor.creds"), evictor, { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership.json"), JSON.stringify({ accountId: auth.account.pub }), { mode: 0o600 });

  let out = "";
  const daemon = spawn(process.execPath, [cotalJs, "deliver", "--space", space, "--server", servers, "--creds", join(root, ".cotal", "delivery.creds")], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" },
  });
  daemon.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
  daemon.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
  cleanups.push(() => { daemon.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });
  check("real delivery daemon boots", await until(() => out.includes("delivery daemon up"), 15_000), out.slice(-300));
  check("membership feed starts from the staged root", await until(() => out.includes("membership feed up"), 8_000), out.slice(-300));

  const supId = newIdentity();
  const ep = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, supId, "supervisor"), card: { id: supId.id, name: "sup", kind: "endpoint" }, consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
  ep.on("error", () => {});
  await ep.start();
  cleanups.push(() => { void ep.stop?.(); });

  // HAPPY
  const results = await remintDaemonCreds(root);
  const expected: { delivery?: string; membership?: string } = {};
  for (const r of results.filter((x) => x.ok)) { if (r.file === DELIVERY_CREDS_KEY && r.fingerprint) expected.delivery = r.fingerprint; else if (r.fingerprint) expected.membership = r.fingerprint; }
  const okReply = await adminReq(ep, "reloadCreds", { expected });
  writeRenewalRecord(root, { ts: new Date().toISOString(), owner: "manager", results, adoption: okReply.ok ? { ok: true, detail: okReply.data } : { ok: false, error: okReply.error, detail: okReply.data } });
  const okData = okReply.data as { delivery?: { brokerAccepted?: unknown }; membership?: { brokerAccepted?: unknown } };
  check("real daemon broker-ACCEPTED the trusted delivery re-sign", okReply.ok === true && okData?.delivery?.brokerAccepted !== undefined, JSON.stringify(okReply).slice(0, 300));
  check("real daemon broker-ACCEPTED the trusted membership re-sign", okData?.membership?.brokerAccepted !== undefined, JSON.stringify(okReply).slice(0, 300));
  const dHappy = runDoctor(root);
  check("`cotal doctor auth` BINARY exits 0 on the broker-accepted renewal", dHappy.code === 0, `code=${dHappy.code} ${dHappy.out.slice(-200)}`);
  check("`cotal doctor auth` renders broker-accepted (not a false 'daemon adopted')", /broker-accepted/.test(dHappy.out) && !/\bdaemon adopted\b/.test(dHappy.out), dHappy.out.slice(-300));

  // REFUSED (the original false-green, now caught)
  const rogueCred = await mintCreds(rogue, dlvId, "delivery", { expiresInSeconds: 300 });
  writeFileSync(join(root, ".cotal", "delivery.creds"), rogueCred, { mode: 0o600 });
  const refusedReply = await adminReq(ep, "reloadCreds", { expected: { delivery: credsFingerprint(rogueCred) } });
  writeRenewalRecord(root, { ts: new Date().toISOString(), owner: "manager", results: [{ file: DELIVERY_CREDS_KEY, ok: true }], adoption: refusedReply.ok ? { ok: true, detail: refusedReply.data } : { ok: false, error: refusedReply.error, detail: refusedReply.data } });
  check("real daemon REFUSED the rogue re-sign (reply ok:false, no brokerAccepted)", refusedReply.ok === false && (refusedReply.data as { delivery?: { brokerAccepted?: unknown } })?.delivery?.brokerAccepted === undefined, JSON.stringify(refusedReply).slice(0, 300));
  const dRefused = runDoctor(root);
  check("`cotal doctor auth` BINARY exits 1 on the broker-refused renewal (no false green)", dRefused.code === 1, `code=${dRefused.code} ${dRefused.out.slice(-250)}`);
  check("`cotal doctor auth` names the refusal, not auth: healthy", /refused by the broker|not broker-accepted/.test(dRefused.out) && !/auth: healthy/.test(dRefused.out), dRefused.out.slice(-300));

  const dFix = runDoctor(root, true);
  check("`cotal doctor auth --fix` does NOT erase the refusal to green (still exit 1)", dFix.code === 1, `code=${dFix.code} ${dFix.out.slice(-250)}`);

  console.log(`\n${fail ? "✗" : "✓"} E2E DOCTOR-BINARY ${pass}/${pass + fail}`);
} finally {
  for (const c of cleanups.reverse()) { try { c(); } catch { /* best effort */ } }
  await wait(300);
}
process.exit(fail ? 1 : 0);
