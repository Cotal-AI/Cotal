/**
 * Cross-owner deny-matrix smoke (the owner+actor flip's SECURITY ACCEPTANCE GATE). Under the flip an
 * identity is a PRINCIPAL = (owner, actor), and the minted broker grant must confine an agent to its OWN
 * (owner, actor) lane — it cannot publish as, nor read the private lanes of, (a) a DIFFERENT owner, nor
 * (b) a SAME-owner SIBLING actor (the property owner-pinning alone would miss; actors are server-pinned).
 *
 * Mints three user-mode-shaped agent creds directly (permissionsFor is principal-parameterized, so an
 * explicit derived-owner principal needs no live callout) and drives a publish/subscribe deny matrix on a
 * real auth broker:
 *   A1 = (u_aaa…, actora1)   A2 = (u_aaa…, actora2, sibling of A1)   B1 = (u_bbb…, actorb1, other owner)
 *
 * Run: pnpm smoke:cross-owner:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, mintCreds, mintLifecycleUid, serverConfig, newIdentity, setupSpaceStreams,
  chatSubject, unicastSubject, unicastRecvFilter, anycastSubject, dinboxSubject, dlvSubject,
  controlServiceSubject, CONTROL_DELIVERY, epRequestSubject, BASELINE_LIFECYCLE_ENDPOINT, membershipBucket,
  principalKey, presenceBucket, spacePrefix,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (p: ReturnType<typeof spawn>, t = 3000): Promise<void> =>
  new Promise((res) => { if (p.exitCode !== null || p.signalCode !== null) return res(); p.once("exit", () => res()); setTimeout(res, t); });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

// Two valid DERIVED owners (u_ + 26 base32-lower) — nkey-disjoint by construction, as the callout mints.
const OWNER_A = "u_" + "a".repeat(26);
const OWNER_B = "u_" + "b".repeat(26);

async function tryPublish(creds: string, subject: string, id: string): Promise<"allowed" | "denied"> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0 });
  try {
    await nc.request(subject, new Uint8Array(0), { timeout: 500 });
    return "allowed"; // a responder replied — or, for $KV/chat with no handler, see catch (no-responders ⇒ accepted)
  } catch (e) {
    const m = (e as Error).message.toLowerCase();
    return m.includes("authorization") || m.includes("permission") ? "denied" : "allowed";
  } finally { await nc.drain().catch(() => {}); }
}

async function trySubscribe(creds: string, id: string, subject: string, graceMs = 350): Promise<"allowed" | "denied"> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0 });
  let denied = false;
  void (async () => { for await (const s of nc.status()) { if (/permission|authorization/i.test(`${(s as { type?: string }).type ?? ""} ${(s as { data?: unknown }).data ?? ""}`)) denied = true; } })().catch(() => {});
  const sub = nc.subscribe(subject, { callback: (err) => { if (err) denied = true; } });
  await nc.flush().catch(() => { denied = true; });
  await wait(graceMs);
  try { sub.unsubscribe(); } catch { /* draining */ }
  await nc.drain().catch(() => {});
  return denied ? "denied" : "allowed";
}

const space = `xowner-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // Streams (so ALLOWED $KV/chat land as real PubAcks, not no-responders) via a provisioner cred.
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // Three agents. A2 is A1's SIBLING (same owner, different actor); B1 is a DIFFERENT owner. Each is a
  // distinct lifecycle (SPEC §13.1): agent creds are lifecycle-keyed, so each mint carries its own uid.
  const idA1 = newIdentity(), idA2 = newIdentity(), idB1 = newIdentity();
  const uidA1 = mintLifecycleUid(), uidA2 = mintLifecycleUid(), uidB1 = mintLifecycleUid();
  const grants = { allowSubscribe: ["general"], allowPublish: ["general"] };
  const a1 = await mintCreds(auth, idA1, "agent", { ...grants, principal: { owner: OWNER_A, actor: "actora1" }, lifecycleUid: uidA1 });
  await mintCreds(auth, idA2, "agent", { ...grants, principal: { owner: OWNER_A, actor: "actora2" }, lifecycleUid: uidA2 });
  await mintCreds(auth, idB1, "agent", { ...grants, principal: { owner: OWNER_B, actor: "actorb1" }, lifecycleUid: uidB1 });
  const pk = (o: string, a: string) => principalKey(o, a).key;

  console.log("A1 = (u_aaa…, actora1). Publish deny matrix:");
  check("post chat AS SELF ALLOWED", await tryPublish(a1, chatSubject(space, OWNER_A, "actora1", "general"), idA1.id) === "allowed");
  check("FORGE chat as a DIFFERENT OWNER (B1) DENIED", await tryPublish(a1, chatSubject(space, OWNER_B, "actorb1", "general"), idA1.id) === "denied");
  check("FORGE chat as a SAME-OWNER SIBLING (A2) DENIED", await tryPublish(a1, chatSubject(space, OWNER_A, "actora2", "general"), idA1.id) === "denied");
  check("send a DM to B1 AS SELF ALLOWED", await tryPublish(a1, unicastSubject(space, OWNER_B, "actorb1", OWNER_A, "actora1"), idA1.id) === "allowed");
  check("FORGE a DM as the SIBLING (A2) DENIED", await tryPublish(a1, unicastSubject(space, OWNER_B, "actorb1", OWNER_A, "actora2"), idA1.id) === "denied");
  check("FORGE a DM as the OTHER OWNER (B1) DENIED", await tryPublish(a1, unicastSubject(space, OWNER_A, "actora1", OWNER_B, "actorb1"), idA1.id) === "denied");
  check("anycast AS SELF ALLOWED", await tryPublish(a1, anycastSubject(space, "worker", OWNER_A, "actora1"), idA1.id) === "allowed");
  check("FORGE anycast as the SIBLING (A2) DENIED", await tryPublish(a1, anycastSubject(space, "worker", OWNER_A, "actora2"), idA1.id) === "denied");
  check("write OWN presence key ALLOWED", await tryPublish(a1, `$KV.${presenceBucket(space)}.${pk(OWNER_A, "actora1")}`, idA1.id) === "allowed");
  check("FORGE the SIBLING's presence key DENIED", await tryPublish(a1, `$KV.${presenceBucket(space)}.${pk(OWNER_A, "actora2")}`, idA1.id) === "denied");
  check("FORGE the OTHER OWNER's presence key DENIED", await tryPublish(a1, `$KV.${presenceBucket(space)}.${pk(OWNER_B, "actorb1")}`, idA1.id) === "denied");

  // Control + delivery-plane forge matrix (defense-in-depth beyond the message lanes): an agent's
  // control grant is its OWN-principal v0.4 ep self-mode `stop` (1d: the manager ctl tiers are
  // deleted; self-stop is the Appendix-B baseline) plus its own-principal ctl.delivery, and it holds
  // no publish on the delivery plane (dinbox/dlv) nor the membership feed — so forging any of these
  // as a sibling or another owner must be denied. Proves the owner+actor pin extends to the ep
  // control rail and the fan-out/handoff plane.
  const epSelfStop = (owner: string, actor: string, uid: string) =>
    epRequestSubject(space, { route: { mode: "one" }, endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "stop", target: { mode: "self" }, caller: { owner, actor, uid }, nonce: "n".repeat(24) });
  check("publish OWN ep self-mode `stop` AS SELF ALLOWED", await tryPublish(a1, epSelfStop(OWNER_A, "actora1", uidA1), idA1.id) === "allowed");
  check("FORGE the SIBLING's (A2) ep self-mode `stop` DENIED", await tryPublish(a1, epSelfStop(OWNER_A, "actora2", uidA2), idA1.id) === "denied");
  check("FORGE ctl.delivery as the OTHER OWNER (B1) DENIED", await tryPublish(a1, controlServiceSubject(space, CONTROL_DELIVERY, OWNER_B, "actorb1"), idA1.id) === "denied");
  check("FORGE-WRITE the SIBLING's dinbox (DM pre-auth fan-out) DENIED", await tryPublish(a1, dinboxSubject(space, OWNER_A, "actora2", uidA2), idA1.id) === "denied");
  check("FORGE-WRITE the OTHER OWNER's dlv (post-auth handoff) DENIED", await tryPublish(a1, dlvSubject(space, OWNER_B, "actorb1", uidB1), idA1.id) === "denied");
  check("FORGE-WRITE a membership-feed key (broker-owned) DENIED", await tryPublish(a1, `$KV.${membershipBucket(space)}.${pk(OWNER_A, "actora2")}`, idA1.id) === "denied");

  console.log("A1 subscribe deny matrix (read boundary):");
  check("read #general (own ACL) ALLOWED", await trySubscribe(a1, idA1.id, chatSubject(space, "*", "*", "general")) === "allowed");
  check("native-tap the OTHER OWNER's DM lane (inst.u_bbb.actorb1.>) DENIED", await trySubscribe(a1, idA1.id, unicastRecvFilter(space, OWNER_B, "actorb1")) === "denied");
  check("native-tap the SIBLING's DM lane (inst.u_aaa.actora2.>) DENIED", await trySubscribe(a1, idA1.id, unicastRecvFilter(space, OWNER_A, "actora2")) === "denied");
  check("read the OTHER OWNER's dinbox (pre-auth fan-out) DENIED", await trySubscribe(a1, idA1.id, dinboxSubject(space, OWNER_B, "actorb1", uidB1)) === "denied");
  check("read the OTHER OWNER's dlv (post-auth handoff) DENIED", await trySubscribe(a1, idA1.id, dlvSubject(space, OWNER_B, "actorb1", uidB1)) === "denied");
  check("read the SIBLING's dlv DENIED", await trySubscribe(a1, idA1.id, dlvSubject(space, OWNER_A, "actora2", uidA2)) === "denied");
  check("native-tap the whole chat firehose (chat.>) DENIED", await trySubscribe(a1, idA1.id, `${spacePrefix(space)}.chat.>`) === "denied");

  console.log(`\nCROSS-OWNER SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
