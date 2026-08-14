/**
 * Observer-cannot-publish smoke — the dashboard's send fence, verified at RUNTIME.
 *
 * The browser dashboard connects on the read-only `admin` profile (`web.ts`: `connectOrExit(values,
 * "admin")`). Its permission set is built with NO `chat`/`inst`/`svc` publish row (`provision.ts`,
 * the observer/admin arm), so the dashboard cannot post — and that claim is the load-bearing one
 * under any future send surface: it says the fence is the BROKER, not the UI. Reading the grant
 * builder proves the SHAPE of that credential; only nats-server proves the BEHAVIOUR. This spins its
 * own JWT-auth server and asks it.
 *
 *   admin    — chat publish, DM (unicast) publish, anycast publish: DENIED.
 *              CHAT stream read: ALLOWED (it is a live, working credential — see below).
 *   operator — chat publish AS SELF: ALLOWED (the positive control — see below).
 *
 * TWO CONTROLS, because three green denials on their own prove nothing:
 *   - A broken harness denies everything. The `operator` arm publishes the SAME subject shape
 *     through the SAME helper and must be ALLOWED, which proves a publish CAN succeed here.
 *   - A dead credential is denied everything. The admin arm must still be ALLOWED its CHAT stream
 *     read, which proves the denial is scoped to publishing rather than being an unusable cred.
 * Without both, "admin is denied" is not evidence about the send fence.
 *
 * Run: pnpm smoke:observer-cannot-publish
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  chatSubject,
  unicastSubject,
  anycastSubject,
  chatStream,
  DEV_OWNER,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

// FIRST ACTION, before any broker is spawned or any cred is minted: this suite must never be able
// to reach the live mesh. A probe that authenticates against production and reports "denied" would
// be reporting production's policy, not this build's.
const LIVE = "broker.cotal.ai";
if (SERVERS.includes(LIVE)) throw new Error(`refusing to run against the live broker (${SERVERS})`);
for (const v of ["COTAL_SERVERS", "COTAL_CREDS"]) delete process.env[v];
if (process.env.COTAL_SERVERS || process.env.COTAL_CREDS)
  throw new Error("ambient COTAL_SERVERS/COTAL_CREDS survived the scrub");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
check("the probe broker is not the live host", !SERVERS.includes(LIVE));

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const awaitExit = (c: ChildProcess) =>
  c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((r) => c.once("exit", () => r()));

/** Publish `subject` as a request using `creds`. Auth Violation ⇒ DENIED; anything else (JS-API
 *  error, No-Responders, timeout) ⇒ ALLOWED — the publish itself was accepted. `inboxPrefix` matches
 *  the cred's `_INBOX_<id>.>` sub so the reply-subscribe is never the gating factor. */
async function tryPublish(creds: string, subject: string, id: string): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  try {
    await nc.request(subject, new Uint8Array(0), { timeout: 500 });
    return "allowed";
  } catch (e) {
    const msg = (e as Error).message.toLowerCase();
    if (msg.includes("authorization") || msg.includes("permission")) return "denied";
    return "allowed";
  } finally {
    await nc.drain().catch(() => {});
  }
}

const space = `web-observer-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-webobs-"));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }),
);
// Record the pid AT CREATION; teardown kills exactly this child and awaits its exit before the
// scratch dir is removed (a still-running server would recreate files under a deleted tree).
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const provisionCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionCreds });

  const adminId = newIdentity();
  const adminCreds = await mintCreds(auth, adminId, "admin");
  const opId = newIdentity();
  const opCreds = await mintCreds(auth, opId, "operator");

  // --- POSITIVE CONTROL: a publish CAN succeed through this helper, on this broker. ---
  console.log("\npositive control - the operator profile posts as itself:");
  check(
    "POSITIVE CONTROL: operator IS ALLOWED chat publish",
    (await tryPublish(opCreds, chatSubject(space, DEV_OWNER, opId.id, "general"), opId.id)) === "allowed",
  );

  // --- THE FENCE: the dashboard's own credential cannot post on any messaging plane. ---
  console.log("\nthe dashboard's admin cred on the messaging planes:");
  check(
    "admin is DENIED chat publish",
    (await tryPublish(adminCreds, chatSubject(space, DEV_OWNER, adminId.id, "general"), adminId.id)) === "denied",
  );
  check(
    "admin is DENIED DM (unicast) publish",
    (await tryPublish(adminCreds, unicastSubject(space, DEV_OWNER, opId.id, DEV_OWNER, adminId.id), adminId.id)) === "denied",
  );
  check(
    "admin is DENIED anycast publish",
    (await tryPublish(adminCreds, anycastSubject(space, "reviewer", DEV_OWNER, adminId.id), adminId.id)) === "denied",
  );

  // --- SECOND CONTROL: the admin cred is a WORKING cred, so the denials above are scoped. ---
  console.log("\nsecond control - the same admin cred still does its read job:");
  check(
    "admin RETAINS its read grant (CHAT stream info)",
    (await tryPublish(adminCreds, `$JS.API.STREAM.INFO.${chatStream(space)}`, adminId.id)) === "allowed",
  );

  console.log(`\nOBSERVER-CANNOT-PUBLISH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
