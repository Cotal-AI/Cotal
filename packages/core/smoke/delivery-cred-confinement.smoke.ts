/**
 * delivery cred confinement smoke (the security NO-GO guard for the delivery daemon, v3). Proves the
 * scoped `delivery` profile is least-privilege server-side infra, NOT allow-all:
 *  - sub.allow is ONLY its own `_INBOX` + the `ctl.delivery.*` control service it serves;
 *  - it has NO native subscription on the mixed pre-auth store (`dinbox.>`) or `chat.>` (a leaked cred
 *    can't sniff them directly — all its stream/KV reads ride the JS API);
 *  - it CANNOT post chat / spoof a peer, nor write the presence/ACL KVs;
 *  - it CAN write any owner's `dinbox`/`dlv` (fan-out + handoff) and ONLY its own lease key;
 *  - an AGENT cred can READ the lease bucket (Component 6 health) but CANNOT write the lease, and still
 *    cannot natively read `dinbox.>`.
 * The fan-out/reader create+consume ALLOW path is exercised end-to-end by the durable-delivery smokes
 * (running the daemon); this smoke is the DENY boundary.
 *
 * Run: pnpm smoke:delivery-cred:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  mintLifecycleUid,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  chatSubject,
  dinboxSubject,
  dlvSubject,
  spacePrefix,
  controlServiceSubject,
  CONTROL_DELIVERY,
  DEV_OWNER,
  deliveryBucket,
  membersBucket,
  aclBucket,
  presenceBucket,
  leaseKey,
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

async function withConn<T>(creds: string, id: string, fn: (nc: Awaited<ReturnType<typeof connect>>, denied: () => boolean) => Promise<T>): Promise<T> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  let perm = false;
  void (async () => {
    for await (const s of nc.status()) {
      // The violation rides a {type:"error", error:{name:"PermissionViolationError"}} event —
      // stringify the WHOLE event (a `${s.data}` render collapses objects and misses it).
      if (/permission|authorization/i.test(JSON.stringify(s))) perm = true;
    }
  })().catch(() => {});
  try {
    return await fn(nc, () => perm);
  } finally {
    await nc.drain().catch(() => {});
  }
}

/** Resolve "denied" if a permission violation surfaces (status channel or sub callback), else "allowed". */
async function trySubscribe(creds: string, id: string, subject: string, graceMs = 350): Promise<"allowed" | "denied"> {
  return withConn(creds, id, async (nc, denied) => {
    let cbDenied = false;
    const sub = nc.subscribe(subject, { callback: (err) => { if (err) cbDenied = true; } });
    await nc.flush().catch(() => { cbDenied = true; });
    await wait(graceMs);
    try { sub.unsubscribe(); } catch { /* ignore */ }
    return denied() || cbDenied ? "denied" : "allowed";
  });
}

/** Resolve "allowed"/"denied" for a raw publish, from the PUBLISHER's own violation events (the
 *  same status-channel classification `trySubscribe` uses; the violation event carries
 *  `PermissionViolationError` with the exact subject). Publisher-side is the only honest
 *  classifier under least-privilege: the old arrival-listener needed a cred that could natively
 *  subscribe the target subject, and since the admin god-view narrowed to the messaging plane
 *  (SPEC 13.9/13.11) no credential can hear `dinbox`/`dlv`/`ctl` natively. For top-level
 *  `$KV.<bucket>.<key>` writes use {@link kvWriteAllowed} instead (the KV API's ack detects the
 *  denial). */
async function publishAllowed(pubCreds: string, pubId: string, subject: string): Promise<"allowed" | "denied"> {
  return withConn(pubCreds, pubId, async (pnc, denied) => {
    pnc.publish(subject, new TextEncoder().encode("x"));
    await pnc.flush().catch(() => {});
    await wait(300);
    return denied() ? "denied" : "allowed";
  });
}

/** Resolve "allowed"/"denied" for a KV WRITE — the KV API awaits a JetStream ack, so a permission-denied
 *  `put` rejects (unlike a fire-and-forget raw publish, which no scoped cred can natively hear on `$KV.>`
 *  now that the allow-all `manager` listener is deleted). */
async function kvWriteAllowed(creds: string, id: string, bucket: string, key: string): Promise<"allowed" | "denied"> {
  return withConn(creds, id, async (nc) => {
    try {
      const kv = await new Kvm(nc).open(bucket);
      await kv.put(key, new TextEncoder().encode("x"));
      return "allowed";
    } catch (e) {
      // Only an authz rejection counts as "denied"; a non-authz failure (e.g. a bucket that wasn't
      // pre-created → "stream not found") must NOT masquerade as a permission denial and false-pass.
      const msg = (e as Error)?.message ?? "";
      if (/permission|authorization|not authorized/i.test(msg)) return "denied";
      throw e;
    }
  });
}

/** Resolve "allowed" if a kv.get succeeds (value or null), "denied" on a permission error. */
async function tryKvGet(creds: string, id: string, bucket: string, key: string): Promise<"allowed" | "denied"> {
  return withConn(creds, id, async (nc) => {
    try {
      const kv = await new Kvm(nc).open(bucket);
      await kv.get(key);
      return "allowed";
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (/permission|authorization|not authorized/i.test(msg)) return "denied";
      throw e; // a non-authz failure must not masquerade as a permission denial
    }
  });
}

const space = `delivery-cred-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-delivcred-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrIdentity = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrIdentity, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // ---- the scoped delivery cred ----
  const d = newIdentity();
  const dCreds = await mintCreds(auth, d, "delivery");
  const owner = newIdentity().id; // some arbitrary owner the daemon writes for
  const ownerUid = mintLifecycleUid(); // its lifecycle uid — dinbox/dlv subjects are lifecycle-keyed (SPEC §13.1)

  // Seed a lease key with the DELIVERY cred — the delivery daemon owns `lease.*` in this bucket. (The
  // scoped manager cred no longer holds a blanket `$KV.>` and so cannot write the delivery lease; only
  // `delivery` may — which this very smoke asserts below.) A raw connection must use the cred's own id.
  await withConn(dCreds, d.id, async (nc) => {
    const kv = await new Kvm(nc).open(deliveryBucket(space));
    await kv.put(leaseKey(0), new TextEncoder().encode(JSON.stringify({ holder: "seed", since: 1 })));
  });

  check("delivery: subscribe own _INBOX is allowed", (await trySubscribe(dCreds, d.id, `_INBOX_${d.id}.reply`)) === "allowed");
  check("delivery: subscribe ctl.delivery.* (serves it) is allowed", (await trySubscribe(dCreds, d.id, controlServiceSubject(space, CONTROL_DELIVERY, "*", "*"))) === "allowed");
  check("delivery: native subscribe dinbox.> (mixed pre-auth store) is DENIED", (await trySubscribe(dCreds, d.id, `${spacePrefix(space)}.dinbox.>`)) === "denied");
  check("delivery: native subscribe chat.> is DENIED", (await trySubscribe(dCreds, d.id, `${spacePrefix(space)}.chat.>`)) === "denied");
  check("delivery: post to a chat channel (spoof a peer) is DENIED", (await publishAllowed(dCreds, d.id, chatSubject(space, DEV_OWNER, d.id, "general"))) === "denied");

  check("delivery: write dinbox.<owner> (fan-out target) is allowed", (await publishAllowed(dCreds, d.id, dinboxSubject(space, DEV_OWNER, owner, ownerUid))) === "allowed");
  check("delivery: write dlv.<owner> (post-auth handoff) is allowed", (await publishAllowed(dCreds, d.id, dlvSubject(space, DEV_OWNER, owner, ownerUid))) === "allowed");
  check("delivery: write its own lease key is allowed", (await kvWriteAllowed(dCreds, d.id, deliveryBucket(space), leaseKey(0))) === "allowed");
  check("delivery: write a NON-lease delivery key is DENIED", (await kvWriteAllowed(dCreds, d.id, deliveryBucket(space), "other")) === "denied");
  check("delivery: write members KV (membership authority) is allowed", (await kvWriteAllowed(dCreds, d.id, membersBucket(space), `review/${owner}`)) === "allowed");
  check("delivery: write ACL KV (manager's job, not the daemon's) is DENIED", (await kvWriteAllowed(dCreds, d.id, aclBucket(space), owner)) === "denied");
  check("delivery: write presence KV is DENIED (it's off the roster)", (await kvWriteAllowed(dCreds, d.id, presenceBucket(space), d.id)) === "denied");
  // ctl.delivery: the daemon publishes REPLIES only (m.respond → ctl.delivery.<id>.reply.<n>), never the
  // request subjects themselves — the scoped `.reply.>` pub grant (tighter than a blanket ctl.delivery.>).
  check("delivery: publish a ctl.delivery REPLY subject is allowed", (await publishAllowed(dCreds, d.id, `${controlServiceSubject(space, CONTROL_DELIVERY, DEV_OWNER, owner)}.reply.1`)) === "allowed");
  check("delivery: publish a ctl.delivery REQUEST subject is DENIED (replies only)", (await publishAllowed(dCreds, d.id, controlServiceSubject(space, CONTROL_DELIVERY, DEV_OWNER, owner))) === "denied");

  // ---- an ordinary agent cred ----
  const { provisionAgent } = await import("../src/index.js");
  const noop = { commitAcl: async () => {}, reissueAcl: async () => {}, provisionDmInbox: async () => {}, provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {} };
  const a = newIdentity();
  const aCreds = await provisionAgent(noop, auth, a, { subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: mintLifecycleUid() });

  check("agent: native subscribe dinbox.> is DENIED (regression)", (await trySubscribe(aCreds, a.id, `${spacePrefix(space)}.dinbox.>`)) === "denied");
  check("agent: READ the delivery lease bucket is allowed (Component 6 health)", (await tryKvGet(aCreds, a.id, deliveryBucket(space), leaseKey(0))) === "allowed");
  check("agent: WRITE the delivery lease is DENIED (only the delivery cred writes it)", (await kvWriteAllowed(aCreds, a.id, deliveryBucket(space), leaseKey(0))) === "denied");

  console.log(`\nDELIVERY-CRED-CONFINEMENT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
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
