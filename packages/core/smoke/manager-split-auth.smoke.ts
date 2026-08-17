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
 *   supervisor  — lease (own key) + own presence: ALLOWED.
 *                 SERVE/reply on the (1d-deleted) manager control tier, DM/DLV consumer-create, DM/DLV read,
 *                 STREAM.DELETE/PURGE/UPDATE/MSG.DELETE (any), native DM-lane tap (sub), chat publish, ACL
 *                 write, peer-presence forge: DENIED.
 *   provisioner — stream/bucket create + DM/DLV/TASK consumer-create + ACL/channel write+read: ALLOWED.
 *                 STREAM.DELETE/PURGE, DM body read (MSG.NEXT), chat publish, lease write: DENIED.
 *   deprovisioner — TARGET-PINNED delete of ITS agent's dm_local-<id>/dlv_local-<id> durable + ACL row: ALLOWED.
 *                 a PEER's durable/ACL (target-pinned), role-shared svc_<role>, DM create/read, STREAM
 *                 DELETE/PURGE, chat publish: DENIED (#159 B).
 *   purger      — STREAM.PURGE on CHAT + DM: ALLOWED.
 *                 DM consumer-create / read, STREAM.DELETE, chat publish, ACL write: DENIED.
 *   operator    — post chat/DM AS SELF + read roster: ALLOWED.
 *                 forge another actor, DM/DLV read, chat-HISTORY read, native DM-lane tap (sub), serve the
 *                 (1d-deleted) manager control tier (sub), STREAM.PURGE/DELETE, ACL write, lease: DENIED.
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
  dlvDurable,
  mintLifecycleUid,
  taskDurable,
  aclKey,
  unicastSubject,
  unicastRecvFilter,
  principalKey,
  DEV_OWNER,
  presenceBucket,
  managerBucket,
  deliveryBucket,
  membersBucket,
  membershipBucket,
  aclBucket,
  channelBucket,
  managerLeaseKey,
  epRequestSubject,
  BASELINE_LIFECYCLE_ENDPOINT,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { assertEphemeralBroker } from "./_ephemeral-only.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
// FIRST action, before any connection: this suite probes provisioner grants (incl. the #286
// STREAM.UPDATE reconcile grant) and must only ever touch a throwaway broker it started itself.
assertEphemeralBroker(SERVERS);
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
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

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

/** Subscribe to `subject` with `creds`; "denied" if a permission/authorization violation surfaces (async
 *  on the connection status channel or the sub callback in nats.js), else "allowed" if the subscription
 *  stays live through the grace window. The publish-only {@link tryPublish} cannot express a native-tap or
 *  serve-control boundary (those are SUBSCRIBE grants) — this does. Mirrors sub-acl-auth.smoke.ts. */
async function trySubscribe(creds: string, id: string, subject: string, graceMs = 400): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  let denied = false;
  void (async () => {
    for await (const s of nc.status()) {
      const blob = `${(s as { type?: string }).type ?? ""} ${(s as { data?: unknown }).data ?? ""}`;
      if (/permission|authorization/i.test(blob)) denied = true;
    }
  })().catch(() => {});
  const sub = nc.subscribe(subject, { callback: (err) => { if (err) denied = true; } });
  await nc.flush().catch(() => { denied = true; });
  await wait(graceMs);
  try { sub.unsubscribe(); } catch { /* ignore */ }
  await nc.drain().catch(() => {});
  return denied ? "denied" : "allowed";
}

/** Just open + close a connection with `creds`. "ok" if the broker accepts the user (the `probe`
 *  profile's whole point — connect is not gated by pub/sub perms), "rejected" on an auth failure. */
async function tryConnect(creds: string, id: string): Promise<"ok" | "rejected"> {
  try {
    const nc = await connect({
      servers: SERVERS,
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      inboxPrefix: `_INBOX_${id}`,
      maxReconnectAttempts: 0,
    });
    await nc.close();
    return "ok";
  } catch {
    return "rejected";
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
  // Deprovisioner (#159 B): ephemeral, TARGET-PINNED teardown — minted for ONE departed agent (`dpvTarget`).
  const dpv = newIdentity();
  const dpvTarget = newIdentity();
  const dpvTargetUid = mintLifecycleUid(); // the ONE retired incarnation this teardown cred may name (SPEC 13.1)
  const dpvCreds = await mintCreds(auth, dpv, "deprovisioner", { deprovisionTarget: { principal: dpvTarget.id, lifecycleUid: dpvTargetUid } });
  const op = newIdentity();
  const opCreds = await mintCreds(auth, op, "operator");
  // PR 1.5 CLI-surface profiles (the last `manager` mints, now scoped).
  const prb = newIdentity(), prbCreds = await mintCreds(auth, prb, "probe");
  const cw = newIdentity(), cwCreds = await mintCreds(auth, cw, "channel-writer");
  const cp = newIdentity(), cpCreds = await mintCreds(auth, cp, "channel-purger");
  const td = newIdentity(), tdUid = mintLifecycleUid(), tdCreds = await mintCreds(auth, td, "teardown", { lifecycleUid: tdUid });
  const ccp = newIdentity(), ccpUid = mintLifecycleUid(), ccpCreds = await mintCreds(auth, ccp, "control-caller-privileged", { lifecycleUid: ccpUid });
  const cca = newIdentity(), ccaUid = mintLifecycleUid(), ccaCreds = await mintCreds(auth, cca, "control-caller-admin", { lifecycleUid: ccaUid });
  const dp = newIdentity(), dpUid = mintLifecycleUid(), dpCreds = await mintCreds(auth, dp, "deployer", { lifecycleUid: dpUid });

  const CHAT = chatStream(space), DM = dmStream(space), DLV = dlvStream(space), TASK = taskStream(space);
  const PKV = `KV_${presenceBucket(space)}`;
  // The DM/DLV consumer-create push-bypass (the create-time deliver_subject isn't ACL-constrained, so a
  // consumer-create = body read). The supervisor MUST NOT have it; the provisioner must.
  const victimUid = mintLifecycleUid();
  const dmCreate = `$JS.API.CONSUMER.DURABLE.CREATE.${DM}.${dmDurable(DEV_OWNER, "victim", victimUid)}`;
  const dlvCreate = `$JS.API.CONSUMER.DURABLE.CREATE.${DLV}.${dlvDurable(DEV_OWNER, "victim", victimUid)}`;
  const dmRead = `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmDurable(DEV_OWNER, "victim", victimUid)}`;
  const dlvRead = `$JS.API.CONSUMER.MSG.NEXT.${DLV}.${dlvDurable(DEV_OWNER, "victim", victimUid)}`;
  // Body reads also ride the direct STREAM.MSG.GET path — assert both DM and DLV are denied there too,
  // so the matrix mirrors the DM AND DLV confidentiality claim directly (review-security), not by omission.
  const dmGet = `$JS.API.STREAM.MSG.GET.${DM}`, dlvGet = `$JS.API.STREAM.MSG.GET.${DLV}`;

  console.log("supervisor (the always-on daemon — the residual-2 gate):");
  check("acquire lease (own per-instance key) ALLOWED", await tryPublish(supCreds, `$KV.${managerBucket(space)}.${managerLeaseKey("inst01")}`, sup.id) === "allowed");
  check("publish OWN presence key ALLOWED", await tryPublish(supCreds, `$KV.${presenceBucket(space)}.${principalKey(DEV_OWNER, sup.id).key}`, sup.id) === "allowed");
  // 1d: the supervisor no longer serves ANY manager control tier (that moved to the endpoint-serve
  // credential), so it can neither reply on nor subscribe a `ctl.manager` tier.
  check("reply on the (deleted) manager control tier DENIED", await tryPublish(supCreds, `${controlServiceSubject(space, "manager", DEV_OWNER, prov.id)}.reply.${randomUUID()}`, sup.id) === "denied");
  check("create a DM consumer (push-bypass) DENIED", await tryPublish(supCreds, dmCreate, sup.id) === "denied");
  check("create a DLV consumer (push-bypass) DENIED", await tryPublish(supCreds, dlvCreate, sup.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(supCreds, dmRead, sup.id) === "denied");
  check("read a DLV body (MSG.NEXT) DENIED", await tryPublish(supCreds, dlvRead, sup.id) === "denied");
  check("direct-get a DM body (STREAM.MSG.GET) DENIED", await tryPublish(supCreds, dmGet, sup.id) === "denied");
  check("direct-get a DLV body (STREAM.MSG.GET) DENIED", await tryPublish(supCreds, dlvGet, sup.id) === "denied");
  check("STREAM.DELETE the presence bucket (roster wipe) DENIED", await tryPublish(supCreds, `$JS.API.STREAM.DELETE.${PKV}`, sup.id) === "denied");
  check("STREAM.PURGE the DM stream DENIED", await tryPublish(supCreds, `$JS.API.STREAM.PURGE.${DM}`, sup.id) === "denied");
  check("publish chat DENIED (never posts)", await tryPublish(supCreds, chatSubject(space, DEV_OWNER, sup.id, "general"), sup.id) === "denied");
  check("write the ACL registry DENIED (not its job)", await tryPublish(supCreds, `$KV.${aclBucket(space)}.${prov.id}`, sup.id) === "denied");
  check("forge a peer's presence key DENIED", await tryPublish(supCreds, `$KV.${presenceBucket(space)}.${principalKey(DEV_OWNER, prov.id).key}`, sup.id) === "denied");
  // Stream-tamper is enumerated-deny, so prove the other admin verbs too (not just DELETE/PURGE): UPDATE
  // (reconfigure a stream) and selective MSG.DELETE (excise a record) are equally absent from the allow-list.
  check("STREAM.UPDATE the presence bucket DENIED", await tryPublish(supCreds, `$JS.API.STREAM.UPDATE.${PKV}`, sup.id) === "denied");
  check("STREAM.MSG.DELETE a presence record DENIED", await tryPublish(supCreds, `$JS.API.STREAM.MSG.DELETE.${PKV}`, sup.id) === "denied");
  // The live-tap path (the broad `manager` had a space-prefix native `sub`): prove the supervisor cannot
  // natively subscribe a peer's DM lane — nor (1d) serve a manager control tier (its serve moved to the
  // endpoint-serve credential on a separate connection).
  check("native-subscribe a peer's DM lane (inst.<victim>) DENIED", await trySubscribe(supCreds, sup.id, unicastRecvFilter(space, DEV_OWNER, prov.id)) === "denied");
  check("serve the (deleted) manager control tier (subscribe ctl.manager.*) DENIED", await trySubscribe(supCreds, sup.id, controlServiceSubject(space, "manager", "*", "*")) === "denied");

  console.log("provisioner (ephemeral onboarding — holds the DM/DLV create surface, nothing destructive):");
  check("CONSUMER.DURABLE.CREATE on DM ALLOWED (the onboarding power)", await tryPublish(provCreds, dmCreate, prov.id) === "allowed");
  check("CONSUMER.DURABLE.CREATE on DLV ALLOWED", await tryPublish(provCreds, dlvCreate, prov.id) === "allowed");
  check("CONSUMER.DURABLE.CREATE on TASK ALLOWED", await tryPublish(provCreds, `$JS.API.CONSUMER.DURABLE.CREATE.${TASK}.svc_worker`, prov.id) === "allowed");
  check("write the ACL registry ALLOWED (commitAcl)", await tryPublish(provCreds, `$KV.${aclBucket(space)}.${sup.id}`, prov.id) === "allowed");
  check("read the ACL registry ALLOWED (commitAcl read-before-write)", await tryPublish(provCreds, `$JS.API.STREAM.MSG.GET.KV_${aclBucket(space)}`, prov.id) === "allowed");
  check("write the channel registry ALLOWED (seed)", await tryPublish(provCreds, `$KV.${channelBucket(space)}.general`, prov.id) === "allowed");
  check("read a DM body (MSG.NEXT) DENIED (creates the mailbox, never reads it)", await tryPublish(provCreds, dmRead, prov.id) === "denied");
  check("read a DLV body (MSG.NEXT) DENIED (creates it, never reads it)", await tryPublish(provCreds, dlvRead, prov.id) === "denied");
  check("direct-get a DM body (STREAM.MSG.GET) DENIED", await tryPublish(provCreds, dmGet, prov.id) === "denied");
  check("STREAM.DELETE the presence bucket DENIED", await tryPublish(provCreds, `$JS.API.STREAM.DELETE.${PKV}`, prov.id) === "denied");
  check("STREAM.PURGE the DM stream DENIED (not a purger)", await tryPublish(provCreds, `$JS.API.STREAM.PURGE.${DM}`, prov.id) === "denied");
  // #286: the provisioner reconciles the three TTL'd KV buckets' `max_age` at `cotal up` (STREAM.UPDATE on
  // presence + the two leases) so a bucket predating the TTL still ages out dead presence / stale leases. The
  // grant is scoped to exactly those three streams — a general stream UPDATE (e.g. the DM mailbox) stays denied.
  check("STREAM.UPDATE the presence bucket ALLOWED (#286 TTL reconcile)", await tryPublish(provCreds, `$JS.API.STREAM.UPDATE.${PKV}`, prov.id) === "allowed");
  check("STREAM.UPDATE the manager-lease bucket ALLOWED (#286 TTL reconcile)", await tryPublish(provCreds, `$JS.API.STREAM.UPDATE.KV_${managerBucket(space)}`, prov.id) === "allowed");
  // The THIRD TTL'd bucket. Its behavioural reconcile is covered elsewhere, but the grant matrix is
  // what this suite is for, and a matrix missing one of the three streams it grants is not a matrix.
  check("STREAM.UPDATE the delivery-lease bucket ALLOWED (#286 TTL reconcile)", await tryPublish(provCreds, `$JS.API.STREAM.UPDATE.KV_${deliveryBucket(space)}`, prov.id) === "allowed");
  check("STREAM.UPDATE the DM stream DENIED (reconcile scoped to the 3 TTL'd buckets)", await tryPublish(provCreds, `$JS.API.STREAM.UPDATE.${DM}`, prov.id) === "denied");
  check("publish chat DENIED", await tryPublish(provCreds, chatSubject(space, DEV_OWNER, prov.id, "general"), prov.id) === "denied");
  check("acquire the manager lease DENIED (not the supervisor)", await tryPublish(provCreds, `$KV.${managerBucket(space)}.${managerLeaseKey("inst01")}`, prov.id) === "denied");

  console.log("agent (lifecycle-keyed binds — a lied COTAL_LIFECYCLE_UID fails at the broker):");
  // The launch-seam spoof gate (D15): an agent's creds pin its OWN lifecycle's exact dm/dlv names,
  // so a session lying about its uid (env or code) simply cannot bind another incarnation's inbox —
  // the broker denies the bind, it never silently reads the wrong lifecycle.
  {
    const agId = newIdentity();
    const agUid = mintLifecycleUid();
    const agCreds = await mintCreds(auth, agId, "agent", { allowSubscribe: ["general"], lifecycleUid: agUid });
    const otherUid = mintLifecycleUid();
    check("bind OWN lifecycle dm durable (MSG.NEXT dm_<self>-<ownUid>) ALLOWED",
      await tryPublish(agCreds, `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmDurable(DEV_OWNER, agId.id, agUid)}`, agId.id) === "allowed");
    check("bind the SAME alias's dm durable under a LIED lifecycle uid DENIED (broker, exact-name grant)",
      await tryPublish(agCreds, `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmDurable(DEV_OWNER, agId.id, otherUid)}`, agId.id) === "denied");
    check("bind the SAME alias's dlv durable under a LIED lifecycle uid DENIED",
      await tryPublish(agCreds, `$JS.API.CONSUMER.MSG.NEXT.${DLV}.${dlvDurable(DEV_OWNER, agId.id, otherUid)}`, agId.id) === "denied");
  }

  console.log("deprovisioner (ephemeral, TARGET-PINNED teardown — deletes ONE agent's local-principal footprint, nothing else):");
  const dpvTargetPrincipal = principalKey(DEV_OWNER, dpvTarget.id).key;
  const supPrincipal = principalKey(DEV_OWNER, sup.id).key;
  const tgtDm = `$JS.API.CONSUMER.DELETE.${DM}.${dmDurable(DEV_OWNER, dpvTarget.id, dpvTargetUid)}`;
  const tgtDlv = `$JS.API.CONSUMER.DELETE.${DLV}.${dlvDurable(DEV_OWNER, dpvTarget.id, dpvTargetUid)}`;
  const tgtAcl = `$KV.${aclBucket(space)}.${aclKey(dpvTargetPrincipal, dpvTargetUid)}`;
  check("DELETE the TARGET's dm_local-<id> durable ALLOWED", await tryPublish(dpvCreds, tgtDm, dpv.id) === "allowed");
  check("DELETE the TARGET's dlv_local-<id> durable ALLOWED", await tryPublish(dpvCreds, tgtDlv, dpv.id) === "allowed");
  check("purge the TARGET's ACL row ($KV.<acl>.<id>) ALLOWED", await tryPublish(dpvCreds, tgtAcl, dpv.id) === "allowed");
  // Target-PINNED: a PEER's local-principal footprint (durable + ACL row) is out of reach — the grants name the target.
  check("DELETE a PEER's dm_local-<id> durable DENIED (target-pinned)", await tryPublish(dpvCreds, `$JS.API.CONSUMER.DELETE.${DM}.${dmDurable(DEV_OWNER, sup.id, dpvTargetUid)}`, dpv.id) === "denied");
  check("DELETE a PEER's dlv_local-<id> durable DENIED (target-pinned)", await tryPublish(dpvCreds, `$JS.API.CONSUMER.DELETE.${DLV}.${dlvDurable(DEV_OWNER, sup.id, dpvTargetUid)}`, dpv.id) === "denied");
  check("purge a PEER's ACL row DENIED (target-pinned)", await tryPublish(dpvCreds, `$KV.${aclBucket(space)}.${aclKey(supPrincipal, dpvTargetUid)}`, dpv.id) === "denied");
  // D15 (SPEC 13.1): the SAME alias under a DIFFERENT lifecycle — the same-name successor's names —
  // is equally out of reach: the grants pin (principal, lifecycleUid) by EXACT name, so a stale or
  // replayed teardown credential is broker-denied against the successor's footprint.
  const successorUid = mintLifecycleUid();
  check("DELETE the SAME alias's dm durable under ANOTHER lifecycle DENIED (successor out of reach)",
    await tryPublish(dpvCreds, `$JS.API.CONSUMER.DELETE.${DM}.${dmDurable(DEV_OWNER, dpvTarget.id, successorUid)}`, dpv.id) === "denied");
  check("DELETE the SAME alias's dlv durable under ANOTHER lifecycle DENIED (successor out of reach)",
    await tryPublish(dpvCreds, `$JS.API.CONSUMER.DELETE.${DLV}.${dlvDurable(DEV_OWNER, dpvTarget.id, successorUid)}`, dpv.id) === "denied");
  check("purge the SAME alias's ACL row under ANOTHER lifecycle DENIED (successor out of reach)",
    await tryPublish(dpvCreds, `$KV.${aclBucket(space)}.${aclKey(dpvTargetPrincipal, successorUid)}`, dpv.id) === "denied");
  // NEVER the role-SHARED svc_<role> (deleting it would break the role's other agents) — no TASK reach at all.
  check("DELETE the role-shared svc_<role> durable DENIED", await tryPublish(dpvCreds, `$JS.API.CONSUMER.DELETE.${TASK}.${taskDurable("worker")}`, dpv.id) === "denied");
  // It DELETES mailboxes; it never CREATES one (not a provisioner) nor READS a body, nor tears a stream down.
  check("CREATE the target's DM consumer DENIED (deprovisions, never provisions)", await tryPublish(dpvCreds, `$JS.API.CONSUMER.DURABLE.CREATE.${DM}.${dmDurable(DEV_OWNER, dpvTarget.id, dpvTargetUid)}`, dpv.id) === "denied");
  check("read the target's DM body (MSG.NEXT) DENIED", await tryPublish(dpvCreds, `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmDurable(DEV_OWNER, dpvTarget.id, dpvTargetUid)}`, dpv.id) === "denied");
  check("direct-get a DM body (STREAM.MSG.GET) DENIED", await tryPublish(dpvCreds, dmGet, dpv.id) === "denied");
  check("STREAM.DELETE the DM stream DENIED (removes consumers, never a stream)", await tryPublish(dpvCreds, `$JS.API.STREAM.DELETE.${DM}`, dpv.id) === "denied");
  check("STREAM.PURGE the chat stream DENIED (not a purger)", await tryPublish(dpvCreds, `$JS.API.STREAM.PURGE.${CHAT}`, dpv.id) === "denied");
  check("publish chat DENIED", await tryPublish(dpvCreds, chatSubject(space, DEV_OWNER, dpvTarget.id, "general"), dpv.id) === "denied");
  // Cross-bucket: the KV grant is the acl bucket ONLY (the target's key). Purging the SAME target key in a
  // DIFFERENT bucket, or STREAM.INFO on a different bucket, must be denied — so a future regression that
  // broadened the grant to `$KV.>` / a bare bucket wouldn't slip through green.
  check("purge the target's key in a DIFFERENT bucket ($KV.<members>.<id>) DENIED", await tryPublish(dpvCreds, `$KV.${membersBucket(space)}.${aclKey(dpvTargetPrincipal, dpvTargetUid)}`, dpv.id) === "denied");
  check("STREAM.INFO a different bucket (KV_<members>) DENIED", await tryPublish(dpvCreds, `$JS.API.STREAM.INFO.KV_${membersBucket(space)}`, dpv.id) === "denied");

  console.log("purger (ephemeral history-purge — purges, never reads):");
  check("STREAM.PURGE on CHAT ALLOWED", await tryPublish(purCreds, `$JS.API.STREAM.PURGE.${CHAT}`, pur.id) === "allowed");
  check("STREAM.PURGE on DM ALLOWED (the isolated --dms grant)", await tryPublish(purCreds, `$JS.API.STREAM.PURGE.${DM}`, pur.id) === "allowed");
  check("create a DM consumer DENIED", await tryPublish(purCreds, dmCreate, pur.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(purCreds, dmRead, pur.id) === "denied");
  check("read a DLV body (MSG.NEXT) DENIED", await tryPublish(purCreds, dlvRead, pur.id) === "denied");
  check("direct-get a DM body (STREAM.MSG.GET) DENIED", await tryPublish(purCreds, dmGet, pur.id) === "denied");
  check("STREAM.DELETE the presence bucket DENIED", await tryPublish(purCreds, `$JS.API.STREAM.DELETE.${PKV}`, pur.id) === "denied");
  check("publish chat DENIED", await tryPublish(purCreds, chatSubject(space, DEV_OWNER, pur.id, "general"), pur.id) === "denied");
  check("write the ACL registry DENIED", await tryPublish(purCreds, `$KV.${aclBucket(space)}.${pur.id}`, pur.id) === "denied");

  console.log("operator (human-CLI client — posts as itself + reads the roster, nothing else):");
  check("post chat AS SELF ALLOWED", await tryPublish(opCreds, chatSubject(space, DEV_OWNER, op.id, "general"), op.id) === "allowed");
  check("DM (inst) AS SELF ALLOWED", await tryPublish(opCreds, unicastSubject(space, DEV_OWNER, sup.id, DEV_OWNER, op.id), op.id) === "allowed");
  check("read the presence roster (STREAM.INFO) ALLOWED", await tryPublish(opCreds, `$JS.API.STREAM.INFO.${PKV}`, op.id) === "allowed");
  check("FORGE chat as another actor DENIED", await tryPublish(opCreds, chatSubject(space, DEV_OWNER, sup.id, "general"), op.id) === "denied");
  check("create a DM consumer DENIED", await tryPublish(opCreds, dmCreate, op.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(opCreds, dmRead, op.id) === "denied");
  check("write the ACL registry DENIED", await tryPublish(opCreds, `$KV.${aclBucket(space)}.${op.id}`, op.id) === "denied");
  check("STREAM.PURGE the chat stream DENIED", await tryPublish(opCreds, `$JS.API.STREAM.PURGE.${CHAT}`, op.id) === "denied");
  check("STREAM.DELETE the presence bucket DENIED", await tryPublish(opCreds, `$JS.API.STREAM.DELETE.${PKV}`, op.id) === "denied");
  check("acquire the manager lease DENIED", await tryPublish(opCreds, `$KV.${managerBucket(space)}.${managerLeaseKey("inst01")}`, op.id) === "denied");
  // The operator posts + reads the roster — it must read NO confidential feed. DLV body-read (symmetric with
  // the DM check above) and chat-HISTORY read (STREAM.MSG.GET on the CHAT stream — distinct from posting):
  check("read a DLV body (MSG.NEXT) DENIED", await tryPublish(opCreds, dlvRead, op.id) === "denied");
  check("read chat history (STREAM.MSG.GET on CHAT) DENIED", await tryPublish(opCreds, `$JS.API.STREAM.MSG.GET.${CHAT}`, op.id) === "denied");
  // ...and cannot live-tap a peer's DM lane nor SERVE/steal the (deleted, 1d) manager control tier.
  check("native-subscribe a peer's DM lane (inst.<victim>) DENIED", await trySubscribe(opCreds, op.id, unicastRecvFilter(space, DEV_OWNER, sup.id)) === "denied");
  check("serve/steal the (deleted) manager control tier (subscribe ctl.manager.*) DENIED", await trySubscribe(opCreds, op.id, controlServiceSubject(space, "manager", "*", "*")) === "denied");

  // ---- PR 1.5 CLI-surface profiles (the last `manager` mints) ----
  const CHKV = `KV_${channelBucket(space)}`, MKV = `KV_${membersBucket(space)}`, MGRKV = `KV_${managerBucket(space)}`;
  const MSHIP = `KV_${membershipBucket(space)}`; // the membership FEED (readMembership) — distinct from the members registry (MKV)
  // 1d: the manager `ctl` tiers are DELETED. `ctlAdmin`/`ctlPriv` build a now-UNGRANTED subject (the
  // green-gate proof: every instrument that used to reach a tier is broker-denied there now); the
  // instruments' real reach is the ep row `epReq` builds (proven ALLOWED alongside each denial).
  const ctlAdmin = (id: string) => controlServiceSubject(space, "admin", DEV_OWNER, id);
  const ctlPriv = (id: string) => controlServiceSubject(space, "manager", DEV_OWNER, id);
  const epReq = (actor: string, uid: string, command: string, target?: Parameters<typeof epRequestSubject>[1]["target"]) =>
    epRequestSubject(space, { route: { mode: "one" }, endpoint: BASELINE_LIFECYCLE_ENDPOINT, command, caller: { owner: DEV_OWNER, actor, uid }, nonce: "n".repeat(24), ...(target ? { target } : {}) });

  console.log("probe (connect-only liveness — opens a socket, can do nothing else):");
  check("connects (liveness) ALLOWED", await tryConnect(prbCreds, prb.id) === "ok");
  check("publish chat DENIED (pub deny >)", await tryPublish(prbCreds, chatSubject(space, DEV_OWNER, prb.id, "general"), prb.id) === "denied");
  check("$JS.API.INFO DENIED", await tryPublish(prbCreds, "$JS.API.INFO", prb.id) === "denied");
  check("read the presence roster (STREAM.INFO) DENIED", await tryPublish(prbCreds, `$JS.API.STREAM.INFO.${PKV}`, prb.id) === "denied");

  console.log("channel-writer (channels set/default + spawn -f seed — writes the channel registry only):");
  check("write the channel registry ($KV.<chBucket>) ALLOWED", await tryPublish(cwCreds, `$KV.${channelBucket(space)}.log`, cw.id) === "allowed");
  check("read the channel registry (STREAM.MSG.GET) ALLOWED", await tryPublish(cwCreds, `$JS.API.STREAM.MSG.GET.${CHKV}`, cw.id) === "allowed");
  check("STREAM.PURGE the chat stream DENIED (not a purger)", await tryPublish(cwCreds, `$JS.API.STREAM.PURGE.${CHAT}`, cw.id) === "denied");
  check("create ANY other stream (STREAM.CREATE.CHAT) DENIED", await tryPublish(cwCreds, `$JS.API.STREAM.CREATE.${CHAT}`, cw.id) === "denied");
  check("STREAM.DELETE the channel bucket DENIED", await tryPublish(cwCreds, `$JS.API.STREAM.DELETE.${CHKV}`, cw.id) === "denied");
  check("write the ACL registry DENIED", await tryPublish(cwCreds, `$KV.${aclBucket(space)}.${cw.id}`, cw.id) === "denied");
  check("publish chat DENIED", await tryPublish(cwCreds, chatSubject(space, DEV_OWNER, cw.id, "general"), cw.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(cwCreds, dmRead, cw.id) === "denied");

  console.log("channel-purger (web channel-delete — channel-writer + the CHAT purge only):");
  check("STREAM.PURGE the chat stream ALLOWED", await tryPublish(cpCreds, `$JS.API.STREAM.PURGE.${CHAT}`, cp.id) === "allowed");
  check("write/delete a channel registry key ALLOWED", await tryPublish(cpCreds, `$KV.${channelBucket(space)}.log`, cp.id) === "allowed");
  check("STREAM.PURGE the DM stream DENIED (CHAT only)", await tryPublish(cpCreds, `$JS.API.STREAM.PURGE.${DM}`, cp.id) === "denied");
  check("STREAM.DELETE the chat stream DENIED", await tryPublish(cpCreds, `$JS.API.STREAM.DELETE.${CHAT}`, cp.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(cpCreds, dmRead, cp.id) === "denied");
  check("publish chat DENIED", await tryPublish(cpCreds, chatSubject(space, DEV_OWNER, cp.id, "general"), cp.id) === "denied");

  console.log("teardown (down -f — the SOLE STREAM.DELETE holder; reads + admin-control + delete, no body read):");
  check("STREAM.DELETE the chat stream ALLOWED", await tryPublish(tdCreds, `$JS.API.STREAM.DELETE.${CHAT}`, td.id) === "allowed");
  check("STREAM.DELETE the manager bucket ALLOWED (all 12)", await tryPublish(tdCreds, `$JS.API.STREAM.DELETE.${MGRKV}`, td.id) === "allowed");
  check("STREAM.DELETE the members bucket ALLOWED (all 12)", await tryPublish(tdCreds, `$JS.API.STREAM.DELETE.${MKV}`, td.id) === "allowed");
  check("STREAM.PURGE the chat stream ALLOWED (clearChannel)", await tryPublish(tdCreds, `$JS.API.STREAM.PURGE.${CHAT}`, td.id) === "allowed");
  check("publish the ep any-mode `despawn` ALLOWED (stop the agents it did not spawn)", await tryPublish(tdCreds, epReq(td.id, tdUid, "despawn", { mode: "any", tOwner: DEV_OWNER }), td.id) === "allowed");
  check("call the (deleted) admin control tier DENIED", await tryPublish(tdCreds, ctlAdmin(td.id), td.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(tdCreds, dmRead, td.id) === "denied");
  check("create a DM consumer DENIED", await tryPublish(tdCreds, dmCreate, td.id) === "denied");
  check("publish chat DENIED", await tryPublish(tdCreds, chatSubject(space, DEV_OWNER, td.id, "general"), td.id) === "denied");
  check("write the ACL registry DENIED", await tryPublish(tdCreds, `$KV.${aclBucket(space)}.${td.id}`, td.id) === "denied");

  console.log("control-caller-privileged (ps/start — the privileged ep instrument set ONLY, no cross-agent reach):");
  check("publish the ep `spawn` ALLOWED (privileged instrument set)", await tryPublish(ccpCreds, epReq(ccp.id, ccpUid, "spawn"), ccp.id) === "allowed");
  check("publish the ep any-mode `despawn` DENIED (structurally barred from cross-agent stop/attach)", await tryPublish(ccpCreds, epReq(ccp.id, ccpUid, "despawn", { mode: "any", tOwner: DEV_OWNER }), ccp.id) === "denied");
  check("call the (deleted) privileged control tier DENIED", await tryPublish(ccpCreds, ctlPriv(ccp.id), ccp.id) === "denied");
  check("call the (deleted) admin control tier DENIED", await tryPublish(ccpCreds, ctlAdmin(ccp.id), ccp.id) === "denied");
  check("read the presence roster (STREAM.INFO) DENIED (no $JS)", await tryPublish(ccpCreds, `$JS.API.STREAM.INFO.${PKV}`, ccp.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(ccpCreds, dmRead, ccp.id) === "denied");
  check("publish chat DENIED", await tryPublish(ccpCreds, chatSubject(space, DEV_OWNER, ccp.id, "general"), ccp.id) === "denied");

  console.log("control-caller-admin (stop/attach — the admin ep instrument set; real cross-agent power, no reads/writes):");
  check("publish the ep any-mode `despawn` ALLOWED (cross-agent stop/attach)", await tryPublish(ccaCreds, epReq(cca.id, ccaUid, "despawn", { mode: "any", tOwner: DEV_OWNER }), cca.id) === "allowed");
  check("call the (deleted) admin control tier DENIED", await tryPublish(ccaCreds, ctlAdmin(cca.id), cca.id) === "denied");
  check("call the (deleted) privileged control tier DENIED", await tryPublish(ccaCreds, ctlPriv(cca.id), cca.id) === "denied");
  check("read the presence roster (STREAM.INFO) DENIED (no $JS)", await tryPublish(ccaCreds, `$JS.API.STREAM.INFO.${PKV}`, cca.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(ccaCreds, dmRead, cca.id) === "denied");
  check("publish chat DENIED", await tryPublish(ccaCreds, chatSubject(space, DEV_OWNER, cca.id, "general"), cca.id) === "denied");
  check("write any KV (channel registry) DENIED", await tryPublish(ccaCreds, `$KV.${channelBucket(space)}.log`, cca.id) === "denied");

  console.log("deployer (spawn -f — reads + admin ep instrument on one ephemeral cred; no writes, no body read):");
  check("publish the ep `launch` ALLOWED (manifest deploy)", await tryPublish(dpCreds, epReq(dp.id, dpUid, "launch"), dp.id) === "allowed");
  check("read the presence roster (STREAM.INFO) ALLOWED", await tryPublish(dpCreds, `$JS.API.STREAM.INFO.${PKV}`, dp.id) === "allowed");
  check("read the channel registry (STREAM.MSG.GET) ALLOWED", await tryPublish(dpCreds, `$JS.API.STREAM.MSG.GET.${CHKV}`, dp.id) === "allowed");
  check("read the manager lease (STREAM.MSG.GET) ALLOWED", await tryPublish(dpCreds, `$JS.API.STREAM.MSG.GET.${MGRKV}`, dp.id) === "allowed");
  check("read the membership feed (STREAM.MSG.GET) ALLOWED (readMembership → detectUnmanagedActors)", await tryPublish(dpCreds, `$JS.API.STREAM.MSG.GET.${MSHIP}`, dp.id) === "allowed");
  check("read the MEMBERS registry (STREAM.MSG.GET) DENIED (deployer reads the membership FEED, not the members registry)", await tryPublish(dpCreds, `$JS.API.STREAM.MSG.GET.${MKV}`, dp.id) === "denied");
  check("call the (deleted) admin control tier DENIED", await tryPublish(dpCreds, ctlAdmin(dp.id), dp.id) === "denied");
  check("call the (deleted) privileged control tier DENIED", await tryPublish(dpCreds, ctlPriv(dp.id), dp.id) === "denied");
  check("read a DM body (MSG.NEXT) DENIED", await tryPublish(dpCreds, dmRead, dp.id) === "denied");
  check("create a DM consumer DENIED", await tryPublish(dpCreds, dmCreate, dp.id) === "denied");
  check("STREAM.DELETE the presence bucket DENIED", await tryPublish(dpCreds, `$JS.API.STREAM.DELETE.${PKV}`, dp.id) === "denied");
  check("write the channel registry ($KV) DENIED (channel-writer seeds, not deployer)", await tryPublish(dpCreds, `$KV.${channelBucket(space)}.log`, dp.id) === "denied");
  check("publish chat (self-post) DENIED", await tryPublish(dpCreds, chatSubject(space, DEV_OWNER, dp.id, "general"), dp.id) === "denied");
  check("native-subscribe a peer's DM lane DENIED", await trySubscribe(dpCreds, dp.id, unicastRecvFilter(space, DEV_OWNER, sup.id)) === "denied");

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
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
