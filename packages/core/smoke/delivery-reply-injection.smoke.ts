/**
 * delivery ctl.delivery reply-injection smoke (security blocker 1 — the confused-deputy guard). The
 * delivery daemon holds a wildcard reply-publish grant (`ctl.delivery.*.reply.>`) and responds to the
 * caller-supplied NATS reply subject. Without a sender-bound check, an attacker could publish on its OWN
 * allowed `ctl.delivery.<attacker>` request subject but set reply-to `ctl.delivery.<victim>.reply.<n>`,
 * turning the daemon into a confused deputy that injects a control reply into the victim's lane. This
 * smoke runs a real delivery endpoint (serveControl with boundReply) and asserts:
 *  - a request with a forged reply target under a PEER's subtree gets NO response (victim sees nothing);
 *  - a request with a legitimate reply under the caller's OWN subtree IS answered (the daemon still works).
 *
 * Run: pnpm smoke:delivery-reply-injection:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  controlServiceSubject,
  CONTROL_DELIVERY,
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
let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `delivery-inject-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-inject-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const noop = { commitAcl: async () => {}, provisionDmInbox: async () => {}, provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {} };
let daemon: CotalEndpoint | undefined;

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // The delivery daemon: a scoped endpoint hosting Plane-3 + serving ctl.delivery (boundReply guard).
  const dCreds = await mintCreds(auth, newIdentity(), "delivery");
  daemon = new CotalEndpoint({
    space, servers: SERVERS, creds: dCreds, channels: [],
    consume: false, watchPresence: true, registerPresence: false,
    card: { name: "delivery", role: "delivery", kind: "endpoint" },
  });
  daemon.on("error", () => {}); // expected: it emits an error when it rejects the forged reply
  await daemon.start();
  await daemon.startPlane3((owner) => daemon!.aclForOwner(owner));

  // Two ordinary agents — attacker + victim. provisionAgent grants each ctl.delivery.<id> pub + reply sub.
  const attacker = newIdentity();
  const aCreds = await provisionAgent(noop, auth, attacker, { subscribe: ["general"], allowSubscribe: ["general"] });
  const victim = newIdentity();
  const vCreds = await provisionAgent(noop, auth, victim, { subscribe: ["general"], allowSubscribe: ["general"] });

  // Victim listens on its OWN reply subtree.
  const vnc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(vCreds)), inboxPrefix: `_INBOX_${victim.id}`, maxReconnectAttempts: 0 });
  let victimGot = false;
  const vsub = vnc.subscribe(`${controlServiceSubject(space, CONTROL_DELIVERY, victim.id)}.>`, { callback: (err, m) => { if (!err && m) victimGot = true; } });
  await vnc.flush();

  // Attacker connects and publishes a request on its OWN allowed subject, but with a FORGED reply target
  // under the victim's reply subtree.
  const anc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(aCreds)), inboxPrefix: `_INBOX_${attacker.id}`, maxReconnectAttempts: 0 });
  const attackerReq = controlServiceSubject(space, CONTROL_DELIVERY, attacker.id);
  const forgedReply = `${controlServiceSubject(space, CONTROL_DELIVERY, victim.id)}.reply.${randomUUID()}`;
  const body = JSON.stringify({ op: "durableJoin", args: { channel: "general" }, from: { id: attacker.id, name: "attacker", kind: "agent" } });
  anc.publish(attackerReq, new TextEncoder().encode(body), { reply: forgedReply });
  await anc.flush();
  await wait(700);
  check("forged reply target (peer's subtree) is NOT answered — no injection into the victim's lane", victimGot === false);

  // Control: a legitimate request with the reply under the attacker's OWN subtree IS answered.
  let attackerGot = false;
  const legitReply = `${attackerReq}.reply.${randomUUID()}`;
  const asub = anc.subscribe(`${attackerReq}.>`, { callback: (err, m) => { if (!err && m) attackerGot = true; } });
  await anc.flush();
  anc.publish(attackerReq, new TextEncoder().encode(body), { reply: legitReply });
  await anc.flush();
  await wait(700);
  check("legitimate own-subtree reply IS answered (the daemon still serves)", attackerGot === true);

  try { vsub.unsubscribe(); asub.unsubscribe(); } catch { /* ignore */ }
  await vnc.drain().catch(() => {});
  await anc.drain().catch(() => {});

  console.log(`\nDELIVERY-REPLY-INJECTION SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await daemon?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
