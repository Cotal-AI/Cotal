/**
 * Control-plane authz smoke (P2a/P5) — the transport boundary, verified at runtime.
 *
 * Spins up its OWN JWT-auth nats-server and proves nats-server — not a handler — enforces the
 * capability→command boundary on the v0.4 ep rails (the manager `ctl` tiers are DELETED, 1d):
 *   - non-capable agent: publish ep `spawn` request DENIED (holds only the Appendix-B baseline)
 *   - spawn-capable agent (capabilities:["spawn"]): ep `spawn` ALLOWED; any-mode `despawn` DENIED
 * The admin instrument set (any-mode despawn/attach + the manager.admin family) is minted only into
 * operator instrument creds — no agent cred, capable or not, holds it (default-deny by omission).
 * A denied publish rejects with an Authorization Violation; an allowed publish with no manager
 * running rejects with "No Responders" / timeout — the error type tells them apart. The full ep
 * grant matrix is manager-split-auth's job; this proves the boundary is broker-enforced.
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
  mintLifecycleUid,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  chatSubject,
  unicastSubject,
  anycastSubject,
  presenceBucket,
  principalKey,
  DEV_OWNER,
  epRequestSubject,
  BASELINE_LIFECYCLE_ENDPOINT,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
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
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
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
  const noop = { commitAcl: async () => {}, reissueAcl: async () => {}, provisionDmInbox: async () => {}, provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {} };
  const plainId = newIdentity(), plainUid = mintLifecycleUid();
  const plainCreds = await provisionAgent(noop, auth, plainId, { subscribe: ["general"], allowPublish: ["general"], lifecycleUid: plainUid });
  const capId = newIdentity(), capUid = mintLifecycleUid();
  const capCreds = await provisionAgent(noop, auth, capId, { subscribe: ["general"], allowPublish: ["general"], capabilities: ["spawn"], lifecycleUid: capUid });

  // The v0.4 ep REQUEST subjects a caller publishes to. `spawn` is untargeted (class rail `ep.one`);
  // a self-mode `stop` is the Appendix-B baseline; an any-mode `despawn` is the admin instrument set.
  const N = "n".repeat(24);
  const ep = (actor: string, uid: string, command: string, target?: Parameters<typeof epRequestSubject>[1]["target"]) =>
    epRequestSubject(space, { route: { mode: "one" }, endpoint: BASELINE_LIFECYCLE_ENDPOINT, command, caller: { owner: DEV_OWNER, actor, uid }, nonce: N, ...(target ? { target } : {}) });
  const plainSpawn = ep(plainId.id, plainUid, "spawn");
  const plainSelfStop = ep(plainId.id, plainUid, "stop", { mode: "self" });
  const capSpawn = ep(capId.id, capUid, "spawn");
  const capAnyDespawn = ep(capId.id, capUid, "despawn", { mode: "any", tOwner: DEV_OWNER });

  console.log("non-capable agent (v0.4 ep rails):");
  check("publish ep self-mode `stop` ALLOWED (Appendix-B baseline)", await tryPublish(plainCreds, plainSelfStop, plainId.id) === "allowed");
  check("publish ep `spawn` DENIED by nats-server (no spawn capability)", await tryPublish(plainCreds, plainSpawn, plainId.id) === "denied");

  console.log("spawn-capable agent (capabilities:[spawn]):");
  check("publish ep `spawn` ALLOWED", await tryPublish(capCreds, capSpawn, capId.id) === "allowed");
  check("publish ep any-mode `despawn` DENIED by nats-server (admin instrument only)", await tryPublish(capCreds, capAnyDespawn, capId.id) === "denied");

  // closure (i) GATE — the scoped `operator` (which replaced the allow-all `manager` for posting) can
  // post AS ITSELF but can NEVER forge a message attributable to another actor. `tryPublish` reports
  // "allowed" when the broker accepts the publish (no responder ⇒ timeout) and "denied" on an
  // Authorization Violation, so a self-post is "allowed" and a cross-actor forge is "denied".
  console.log("scoped operator (closure (i) — self-scoped publish, no forge):");
  const victim = newIdentity();
  check("operator post chat AS SELF ALLOWED", await tryPublish(opCreds, chatSubject(space, DEV_OWNER, opId.id, "general"), opId.id) === "allowed");
  check("operator FORGE chat as another actor DENIED", await tryPublish(opCreds, chatSubject(space, DEV_OWNER, victim.id, "general"), opId.id) === "denied");
  check("operator DM (inst) AS SELF ALLOWED", await tryPublish(opCreds, unicastSubject(space, DEV_OWNER, victim.id, DEV_OWNER, opId.id), opId.id) === "allowed");
  check("operator FORGE inst as another actor DENIED", await tryPublish(opCreds, unicastSubject(space, DEV_OWNER, victim.id, DEV_OWNER, victim.id), opId.id) === "denied");
  check("operator anycast (svc) AS SELF ALLOWED", await tryPublish(opCreds, anycastSubject(space, "worker", DEV_OWNER, opId.id), opId.id) === "allowed");
  check("operator FORGE svc as another actor DENIED", await tryPublish(opCreds, anycastSubject(space, "worker", DEV_OWNER, victim.id), opId.id) === "denied");

  // closure (i) residual (3) — the scoped operator writes ONLY its OWN presence key (`$KV.<presence>.<id>`),
  // so a leaked operator cred cannot spoof a peer's roster-visible identity/status. (The READ side also
  // drops a presence record whose KV key != its card.id — endpoint.ts applyPresence.) A `$KV` publish to
  // an allowed key replies with a PubAck ("allowed"); a denied key is an Authorization Violation ("denied").
  console.log("scoped operator (closure (i) residual (3) — presence write is self-keyed, no roster spoof):");
  check("operator write OWN presence key ALLOWED", await tryPublish(opCreds, `$KV.${presenceBucket(space)}.${principalKey(DEV_OWNER, opId.id).key}`, opId.id) === "allowed");
  check("operator FORGE a peer's presence key DENIED", await tryPublish(opCreds, `$KV.${presenceBucket(space)}.${principalKey(DEV_OWNER, victim.id).key}`, opId.id) === "denied");
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
