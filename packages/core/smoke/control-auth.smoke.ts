/**
 * Control-plane authz smoke (P2a/P5) — the transport boundary, verified at runtime.
 *
 * Spins up its OWN JWT-auth nats-server and proves nats-server — not a handler — enforces the
 * three-tier admin / privileged / self-service control-subject split:
 *   - non-capable agent: publish to ctl.self.<id> ALLOWED; ctl.manager.<id> + ctl.admin.<id> DENIED
 *   - spawn-capable agent (capabilities:["spawn"]): ctl.manager.<id> ALLOWED; ctl.admin.<id> DENIED
 * Admin is manager-profile-only — no agent cred, capable or not, may reach it (default-deny by
 * omission), so purge + cross-agent ops can't be published by a compromised peer at all.
 * A denied publish rejects the request with an Authorization Violation; an allowed publish with
 * no manager running rejects with "No Responders" / timeout — the error type tells them apart.
 *
 * Run: pnpm smoke:control-auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  controlServiceSubject,
  chatSubject,
  unicastSubject,
  anycastSubject,
  presenceBucket,
  CONTROL_PRIVILEGED,
  CONTROL_SELF_SERVICE,
  CONTROL_ADMIN,
} from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const space = `ctl-auth-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-ctlauth-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

/** Try to publish `subject` as a request from a fresh connection using `creds`. The error type
 *  classifies the outcome: an Authorization Violation ⇒ the server DENIED the publish; anything
 *  else (No Responders / timeout) ⇒ the server accepted the publish (no handler replied). The
 *  `inboxPrefix` matches the agent cred's subscribe allow-list (`_INBOX_<id>.>`) so the request's
 *  reply-subscribe isn't the gating factor — the publish is. */
async function tryPublish(creds: string, subject: string, id: string): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  try {
    await nc.request(subject, new Uint8Array(0), { timeout: 500 });
    return "allowed"; // a responder replied (no manager here, so this branch won't fire)
  } catch (e) {
    const msg = (e as Error).message.toLowerCase();
    if (msg.includes("authorization") || msg.includes("permission")) return "denied";
    return "allowed"; // No Responders / timeout ⇒ publish was accepted, just no reply
  } finally {
    await nc.drain().catch(() => {});
  }
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // Setup uses the provisioner (streams/buckets); the self-scoped poster below uses `operator` — the
  // profile that replaced the former allow-all `manager` for posting AS the operator (closure (i)).
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const opId = newIdentity();
  const opCreds = await mintCreds(auth, opId, "operator");

  // Two agents: one without capabilities, one declaring spawn. The stub provisioner skips
  // durable pre-create (we only need the creds' publish allow-list, which is what nats-server
  // enforces).
  const noop = { commitAcl: async () => {}, provisionDmInbox: async () => {}, provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {} };
  const plainId = newIdentity();
  const plainCreds = await provisionAgent(noop, auth, plainId, { subscribe: ["general"], allowPublish: ["general"] });
  const capId = newIdentity();
  const capCreds = await provisionAgent(noop, auth, capId, { subscribe: ["general"], allowPublish: ["general"], capabilities: ["spawn"] });

  const plainSelf = controlServiceSubject(space, CONTROL_SELF_SERVICE, plainId.id);
  const plainPriv = controlServiceSubject(space, CONTROL_PRIVILEGED, plainId.id);
  const plainAdmin = controlServiceSubject(space, CONTROL_ADMIN, plainId.id);
  const capPriv = controlServiceSubject(space, CONTROL_PRIVILEGED, capId.id);
  const capAdmin = controlServiceSubject(space, CONTROL_ADMIN, capId.id);

  console.log("non-capable agent:");
  check("publish ctl.self.<id> ALLOWED", await tryPublish(plainCreds, plainSelf, plainId.id) === "allowed");
  check("publish ctl.manager.<id> DENIED by nats-server", await tryPublish(plainCreds, plainPriv, plainId.id) === "denied");
  check("publish ctl.admin.<id> DENIED by nats-server", await tryPublish(plainCreds, plainAdmin, plainId.id) === "denied");

  console.log("spawn-capable agent (capabilities:[spawn]):");
  check("publish ctl.manager.<id> ALLOWED", await tryPublish(capCreds, capPriv, capId.id) === "allowed");
  check("publish ctl.admin.<id> DENIED by nats-server", await tryPublish(capCreds, capAdmin, capId.id) === "denied");

  // closure (i) GATE — the scoped `operator` (which replaced the allow-all `manager` for posting) can
  // post AS ITSELF but can NEVER forge a message attributable to another actor. `tryPublish` reports
  // "allowed" when the broker accepts the publish (no responder ⇒ timeout) and "denied" on an
  // Authorization Violation, so a self-post is "allowed" and a cross-actor forge is "denied".
  console.log("scoped operator (closure (i) — self-scoped publish, no forge):");
  const victim = newIdentity();
  check("operator post chat AS SELF ALLOWED", await tryPublish(opCreds, chatSubject(space, opId.id, "general"), opId.id) === "allowed");
  check("operator FORGE chat as another actor DENIED", await tryPublish(opCreds, chatSubject(space, victim.id, "general"), opId.id) === "denied");
  check("operator DM (inst) AS SELF ALLOWED", await tryPublish(opCreds, unicastSubject(space, victim.id, opId.id), opId.id) === "allowed");
  check("operator FORGE inst as another actor DENIED", await tryPublish(opCreds, unicastSubject(space, victim.id, victim.id), opId.id) === "denied");
  check("operator anycast (svc) AS SELF ALLOWED", await tryPublish(opCreds, anycastSubject(space, "worker", opId.id), opId.id) === "allowed");
  check("operator FORGE svc as another actor DENIED", await tryPublish(opCreds, anycastSubject(space, "worker", victim.id), opId.id) === "denied");

  // closure (i) residual (3) — the scoped operator writes ONLY its OWN presence key (`$KV.<presence>.<id>`),
  // so a leaked operator cred cannot spoof a peer's roster-visible identity/status. (The READ side also
  // drops a presence record whose KV key != its card.id — endpoint.ts applyPresence.) A `$KV` publish to
  // an allowed key replies with a PubAck ("allowed"); a denied key is an Authorization Violation ("denied").
  console.log("scoped operator (closure (i) residual (3) — presence write is self-keyed, no roster spoof):");
  check("operator write OWN presence key ALLOWED", await tryPublish(opCreds, `$KV.${presenceBucket(space)}.${opId.id}`, opId.id) === "allowed");
  check("operator FORGE a peer's presence key DENIED", await tryPublish(opCreds, `$KV.${presenceBucket(space)}.${victim.id}`, opId.id) === "denied");
  check("operator PURGE the presence stream (force-offline a peer) DENIED", await tryPublish(opCreds, `$JS.API.STREAM.PURGE.KV_${presenceBucket(space)}`, opId.id) === "denied");

  console.log(`\nCONTROL-AUTH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
