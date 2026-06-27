/**
 * Manager-cred split authz smoke (closure (ii), residual 2) — the deny-matrix, verified at runtime.
 *
 * Spins up its OWN JWT-auth nats-server and proves nats-server enforces the least-privilege split of the
 * former allow-all `manager` into supervisor / provisioner / purger. The residual-2 gate is that the
 * always-on SUPERVISOR can no longer read DM/DLV bodies (no consumer-create push-bypass) nor tamper with
 * a stream (no STREAM.DELETE/PURGE), while the ephemeral PROVISIONER holds the DM/DLV consumer-create
 * onboarding surface and the ephemeral PURGER holds the isolated history-purge grant — and neither of
 * those can do the supervisor's job or read a body.
 *
 *   supervisor  — lease (own key) + own presence + control reply: ALLOWED.
 *                 DM/DLV consumer-create, DM read, STREAM.DELETE/PURGE (any), chat publish, ACL write,
 *                 peer-presence forge: DENIED.
 *   provisioner — stream/bucket create + DM/DLV/TASK consumer-create + ACL/channel write+read: ALLOWED.
 *                 STREAM.DELETE/PURGE, DM body read (MSG.NEXT), chat publish, lease write: DENIED.
 *   purger      — STREAM.PURGE on CHAT + DM: ALLOWED.
 *                 DM consumer-create / read, STREAM.DELETE, chat publish, ACL write: DENIED.
 *
 * A denied publish/request rejects with an Authorization Violation; an allowed one rejects with a JS-API
 * error or No-Responders/timeout — the error type tells them apart (see {@link tryPublish}).
 *
 * Run: pnpm smoke:manager-split
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
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  controlServiceSubject,
  chatSubject,
  chatStream,
  dmStream,
  dlvStream,
  taskStream,
  dmDurable,
  presenceBucket,
  managerBucket,
  aclBucket,
  channelBucket,
  MANAGER_LEASE_KEY,
  CONTROL_PRIVILEGED,
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

const space = `mgr-split-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-mgrsplit-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

/** Publish `subject` as a request using `creds`. Auth Violation ⇒ DENIED; anything else (JS-API error,
 *  No-Responders, timeout) ⇒ ALLOWED (the publish itself was accepted). `inboxPrefix` matches the cred's
 *  `_INBOX_<id>.>` sub so the request's reply-subscribe is never the gating factor — the publish is. */
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

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // `cotal up` pre-creates the streams + buckets (incl. managerBucket) under a privileged cred.
  const provisionId = newIdentity();
  const provisionCreds = await mintCreds(auth, provisionId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionCreds });

  const sup = newIdentity();
  const supCreds = await mintCreds(auth, sup, "supervisor");
  const prov = newIdentity();
  const provCreds = await mintCreds(auth, prov, "provisioner");
  const pur = newIdentity();
  const purCreds = await mintCreds(auth, pur, "purger");

  const CHAT = chatStream(space), DM = dmStream(space), DLV = dlvStream(space), TASK = taskStream(space);
  const PKV = `KV_${presenceBucket(space)}`;
  // The DM/DLV consumer-create push-bypass (the create-time deliver_subject isn't ACL-constrained, so a
  // consumer-create = body read). The supervisor MUST NOT have it; the provisioner must.
  const dmCreate = `$JS.API.CONSUMER.DURABLE.CREATE.${DM}.${dmDurable("victim")}`;
  const dlvCreate = `$JS.API.CONSUMER.DURABLE.CREATE.${DLV}.dlv_victim`;
  const dmRead = `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmDurable("victim")}`;

  console.log("supervisor (the always-on daemon — the residual-2 gate):");
  check("acquire lease (own key) ALLOWED", await tryPublish(supCreds, `$KV.${managerBucket(space)}.${MANAGER_LEASE_KEY}`, sup.id) === "allowed");
  check("publish OWN presence key ALLOWED", await tryPublish(supCreds, `$KV.${presenceBucket(space)}.${sup.id}`, sup.id) === "allowed");
  check("reply on a served control tier ALLOWED", await tryPublish(supCreds, `${controlServiceSubject(space, CONTROL_PRIVILEGED, prov.id)}.reply.${randomUUID()}`, sup.id) === "allowed");
  check("create a DM consumer (push-bypass) DENIED", await tryPublish(supCreds, dmCreate, sup.id) === "denied");
  check("create a DLV consumer (push-bypass) DENIED", await tryPublish(supCreds, dlvCreate, sup.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(supCreds, dmRead, sup.id) === "denied");
  check("STREAM.DELETE the presence bucket (roster wipe) DENIED", await tryPublish(supCreds, `$JS.API.STREAM.DELETE.${PKV}`, sup.id) === "denied");
  check("STREAM.PURGE the DM stream DENIED", await tryPublish(supCreds, `$JS.API.STREAM.PURGE.${DM}`, sup.id) === "denied");
  check("publish chat DENIED (never posts)", await tryPublish(supCreds, chatSubject(space, sup.id, "general"), sup.id) === "denied");
  check("write the ACL registry DENIED (not its job)", await tryPublish(supCreds, `$KV.${aclBucket(space)}.${prov.id}`, sup.id) === "denied");
  check("forge a peer's presence key DENIED", await tryPublish(supCreds, `$KV.${presenceBucket(space)}.${prov.id}`, sup.id) === "denied");

  console.log("provisioner (ephemeral onboarding — holds the DM/DLV create surface, nothing destructive):");
  check("CONSUMER.DURABLE.CREATE on DM ALLOWED (the onboarding power)", await tryPublish(provCreds, dmCreate, prov.id) === "allowed");
  check("CONSUMER.DURABLE.CREATE on DLV ALLOWED", await tryPublish(provCreds, dlvCreate, prov.id) === "allowed");
  check("CONSUMER.DURABLE.CREATE on TASK ALLOWED", await tryPublish(provCreds, `$JS.API.CONSUMER.DURABLE.CREATE.${TASK}.svc_worker`, prov.id) === "allowed");
  check("write the ACL registry ALLOWED (commitAcl)", await tryPublish(provCreds, `$KV.${aclBucket(space)}.${sup.id}`, prov.id) === "allowed");
  check("read the ACL registry ALLOWED (commitAcl read-before-write)", await tryPublish(provCreds, `$JS.API.STREAM.MSG.GET.KV_${aclBucket(space)}`, prov.id) === "allowed");
  check("write the channel registry ALLOWED (seed)", await tryPublish(provCreds, `$KV.${channelBucket(space)}.general`, prov.id) === "allowed");
  check("read a DM body (MSG.NEXT) DENIED (creates the mailbox, never reads it)", await tryPublish(provCreds, dmRead, prov.id) === "denied");
  check("STREAM.DELETE the presence bucket DENIED", await tryPublish(provCreds, `$JS.API.STREAM.DELETE.${PKV}`, prov.id) === "denied");
  check("STREAM.PURGE the DM stream DENIED (not a purger)", await tryPublish(provCreds, `$JS.API.STREAM.PURGE.${DM}`, prov.id) === "denied");
  check("publish chat DENIED", await tryPublish(provCreds, chatSubject(space, prov.id, "general"), prov.id) === "denied");
  check("acquire the manager lease DENIED (not the supervisor)", await tryPublish(provCreds, `$KV.${managerBucket(space)}.${MANAGER_LEASE_KEY}`, prov.id) === "denied");

  console.log("purger (ephemeral history-purge — purges, never reads):");
  check("STREAM.PURGE on CHAT ALLOWED", await tryPublish(purCreds, `$JS.API.STREAM.PURGE.${CHAT}`, pur.id) === "allowed");
  check("STREAM.PURGE on DM ALLOWED (the isolated --dms grant)", await tryPublish(purCreds, `$JS.API.STREAM.PURGE.${DM}`, pur.id) === "allowed");
  check("create a DM consumer DENIED", await tryPublish(purCreds, dmCreate, pur.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(purCreds, dmRead, pur.id) === "denied");
  check("STREAM.DELETE the presence bucket DENIED", await tryPublish(purCreds, `$JS.API.STREAM.DELETE.${PKV}`, pur.id) === "denied");
  check("publish chat DENIED", await tryPublish(purCreds, chatSubject(space, pur.id, "general"), pur.id) === "denied");
  check("write the ACL registry DENIED", await tryPublish(purCreds, `$KV.${aclBucket(space)}.${pur.id}`, pur.id) === "denied");

  console.log(`\nMANAGER-SPLIT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
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
