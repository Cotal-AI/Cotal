/**
 * Deprovision-on-exit functional smoke (#159 Part B2) — the teardown counterpart to `provisionAgent`,
 * verified end to end against a real JWT-auth nats-server.
 *
 * Boots its own auth broker, provisions an agent the real way (a provisioner endpoint → `provisionAgent`,
 * which creates the bind-only `dm_<id>` + `dlv_<id>` durables, records the read-ACL row, and creates the
 * role-shared `svc_<role>` TASK durable), then runs `deprovisionAgent` with a TARGET-PINNED `deprovisioner`
 * cred and proves it is the exact inverse of the id-keyed footprint — and NOTHING more:
 *
 *   - `dm_<id>` + `dlv_<id>` durables: GONE.
 *   - the read-ACL row: GONE (the reader now treats the owner as unknown).
 *   - the role-shared `svc_<role>` durable: UNTOUCHED (deleting it would break the role's other agents;
 *     it lives until space teardown) — the correctness catch the plan calls out.
 *   - a second `deprovisionAgent` is a no-op (idempotent — a missing consumer / absent ACL row never throws).
 *
 * The permission BOUNDARIES of the `deprovisioner` profile (target-pinned, no body read, no svc_<role>,
 * no stream tamper) are proven separately in the deny-matrix (`manager-split-auth.smoke.ts`); this proves
 * the FUNCTIONAL teardown a manager runs when an agent exits.
 *
 * Run: pnpm smoke:deprovision
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  provisionAgent,
  deprovisionAgent,
  openAclRegistry,
  readAcl,
  mintLifecycleUid,
  CotalEndpoint,
  dmStream,
  dlvStream,
  taskStream,
  dmDurable,
  dlvDurable,
  taskDurable,
  DEV_OWNER,
  principalKey,
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

const space = `deprov-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-deprov-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const localPrincipal = (actor: string) => principalKey(DEV_OWNER, actor).key;

/** Does consumer `name` exist on `stream`? Opens a short-lived provisioner-cred jsm to check. */
async function consumerExists(provCreds: string, provId: string, stream: string, name: string): Promise<boolean> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)),
    inboxPrefix: `_INBOX_${provId}`,
    maxReconnectAttempts: 0,
  });
  try {
    const jsm = await jetstreamManager(nc);
    await jsm.consumers.info(stream, name);
    return true;
  } catch {
    return false; // ConsumerNotFound (or gone) → false
  } finally {
    await nc.drain().catch(() => {});
  }
}

/** Is `owner`'s read-ACL row present? Reads it via a provisioner-cred connection. */
async function aclPresent(provCreds: string, provId: string, owner: string, lifecycleUid: string): Promise<boolean> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)),
    inboxPrefix: `_INBOX_${provId}`,
    maxReconnectAttempts: 0,
  });
  try {
    return (await readAcl(await openAclRegistry(nc, space), owner, lifecycleUid)) !== undefined;
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

  const DM = dmStream(space), DLV = dlvStream(space), TASK = taskStream(space);

  // ---- provision an agent the real way (provisioner endpoint → provisionAgent) ----
  const provId = newIdentity();
  const provCreds = await mintCreds(auth, provId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  const prov = new CotalEndpoint({
    space, servers: SERVERS, creds: provCreds,
    card: { id: provId.id, name: "prov", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  prov.on("error", (e: Error) => console.error("  ! prov", e.message));
  await prov.start();

  const agent = newIdentity();
  const uidA = mintLifecycleUid(); // incarnation A — every name below embeds it (SPEC 13.1)
  await provisionAgent(prov, auth, agent, { subscribe: ["general"], allowSubscribe: ["general"], role: "worker", lifecycleUid: uidA });

  console.log("after provisionAgent — the lifecycle-keyed footprint + the role-shared svc_<role> exist:");
  check("dm_local-<id>-<uidA> durable present", await consumerExists(provCreds, provId.id, DM, dmDurable(DEV_OWNER, agent.id, uidA)));
  check("dlv_local-<id>-<uidA> durable present", await consumerExists(provCreds, provId.id, DLV, dlvDurable(DEV_OWNER, agent.id, uidA)));
  check("svc_<role> (worker) durable present", await consumerExists(provCreds, provId.id, TASK, taskDurable("worker")));
  check("read-ACL row present (lifecycle-keyed)", await aclPresent(provCreds, provId.id, localPrincipal(agent.id), uidA));

  // ---- deprovision with a TARGET-PINNED cred (what the manager mints on the agent's exit) ----
  const dpvCreds = await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: agent.id, lifecycleUid: uidA } });
  await deprovisionAgent({ servers: SERVERS, space, targetId: agent.id, lifecycleUid: uidA, creds: dpvCreds });

  console.log("after deprovisionAgent — the lifecycle A footprint is gone; the role-shared durable survives:");
  check("dm_local-<id>-<uidA> durable GONE", !(await consumerExists(provCreds, provId.id, DM, dmDurable(DEV_OWNER, agent.id, uidA))));
  check("dlv_local-<id>-<uidA> durable GONE", !(await consumerExists(provCreds, provId.id, DLV, dlvDurable(DEV_OWNER, agent.id, uidA))));
  check("read-ACL row GONE", !(await aclPresent(provCreds, provId.id, localPrincipal(agent.id), uidA)));
  check("svc_<role> (worker) durable UNTOUCHED (role-shared — siblings still bind it)", await consumerExists(provCreds, provId.id, TASK, taskDurable("worker")));

  // ---- idempotent: a second teardown (missing consumers / absent ACL row) must not throw ----
  let threw = false;
  try {
    await deprovisionAgent({ servers: SERVERS, space, targetId: agent.id, lifecycleUid: uidA, creds: dpvCreds });
  } catch (e) {
    threw = true;
    console.error("  ! second deprovision threw:", (e as Error).message);
  }
  check("second deprovisionAgent is a no-op (idempotent)", !threw);

  // ---- THE D15 BARRIERS (SPEC 13.1): a same-name SUCCESSOR is untouchable by the retired
  // lifecycle's teardown — by NAME DISJOINTNESS (the replay names only A's uid) and by the
  // BROKER (A's cred is denied on B's exact names). ----
  // FRONTIER PROBE setup (SPEC :467 / 13.1): a DM published to the ALIAS while no successor
  // exists (between A's retirement and B's provisioning) must NOT flow to B — B's dm durable
  // starts at the activation frontier captured at ITS provisioning. Publish DM1 now, DM2 after.
  const insp = await (async () => {
    const inspId = newIdentity();
    const { encodeUser, fmtCreds } = await import("@nats-io/jwt");
    const { fromPublic, fromSeed } = await import("@nats-io/nkeys");
    const signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
    const jwt = await encodeUser("deprov-inspector", fromPublic(inspId.id), fromPublic(auth.account.pub),
      { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer });
    const creds = new TextDecoder().decode(fmtCreds(jwt, fromSeed(new TextEncoder().encode(inspId.seed))));
    return connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
  })();
  const { jetstream } = await import("@nats-io/jetstream");
  const inspJs = jetstream(insp);
  const aliasDm = `cotal.${space}.inst.${DEV_OWNER}.${agent.id}.${DEV_OWNER}.peer`;
  await inspJs.publish(aliasDm, JSON.stringify({ id: "dm1", body: "pre-successor" }));

  const uidB = mintLifecycleUid(); // incarnation B: same actor id, fresh lifecycle
  await provisionAgent(prov, auth, agent, { subscribe: ["general"], allowSubscribe: ["general"], role: "worker", lifecycleUid: uidB });
  await prov.stop();
  await inspJs.publish(aliasDm, JSON.stringify({ id: "dm2", body: "post-successor" }));
  check("successor (uidB) footprint present after same-name re-provision",
    (await consumerExists(provCreds, provId.id, DM, dmDurable(DEV_OWNER, agent.id, uidB)))
    && (await consumerExists(provCreds, provId.id, DLV, dlvDurable(DEV_OWNER, agent.id, uidB)))
    && (await aclPresent(provCreds, provId.id, localPrincipal(agent.id), uidB)));

  // REPLAY of the retired lifecycle A's teardown (the at-least-once world): its cred + its uid.
  // It must be a harmless no-op against A's already-gone names and CANNOT resolve to B's.
  let replayThrew = false;
  try {
    await deprovisionAgent({ servers: SERVERS, space, targetId: agent.id, lifecycleUid: uidA, creds: dpvCreds });
  } catch { replayThrew = true; }
  check("replayed retired-lifecycle teardown is a no-op (never resolves to the successor)", !replayThrew);
  check("successor dm durable SURVIVES the replayed teardown", await consumerExists(provCreds, provId.id, DM, dmDurable(DEV_OWNER, agent.id, uidB)));
  check("successor dlv durable SURVIVES the replayed teardown", await consumerExists(provCreds, provId.id, DLV, dlvDurable(DEV_OWNER, agent.id, uidB)));
  check("successor read-ACL row SURVIVES the replayed teardown", await aclPresent(provCreds, provId.id, localPrincipal(agent.id), uidB));

  // A CONFUSED/HOSTILE holder of A's teardown cred aiming it AT B's names: the cred's exact-name
  // grants are broker-DENIED on B's names, so the attempt fails (denied pub = JS-API timeout or a
  // loud error, never a delete) and B's footprint is intact.
  let wrongUidOutcome = "completed";
  try {
    await deprovisionAgent({ servers: SERVERS, space, targetId: agent.id, lifecycleUid: uidB, creds: dpvCreds });
  } catch { wrongUidOutcome = "threw"; }
  check("A's teardown cred aimed at B's names is broker-DENIED (threw, never deleted)", wrongUidOutcome === "threw", { wrongUidOutcome });
  check("successor dm durable INTACT after the denied wrong-uid attempt", await consumerExists(provCreds, provId.id, DM, dmDurable(DEV_OWNER, agent.id, uidB)));
  check("successor dlv durable INTACT after the denied wrong-uid attempt", await consumerExists(provCreds, provId.id, DLV, dlvDurable(DEV_OWNER, agent.id, uidB)));
  check("successor read-ACL row INTACT after the denied wrong-uid attempt", await aclPresent(provCreds, provId.id, localPrincipal(agent.id), uidB));

  // FRONTIER PROBE assert: B's dm durable (ByStartSequence frontier+1) delivers ONLY the
  // post-provisioning DM — the pre-successor alias DM is below B's frontier and never flows
  // forward ("a replacement inherits no pending DMs", SPEC 13.1).
  {
    const jsmI = await jetstreamManager(insp);
    const ci = await jsmI.consumers.info(DM, dmDurable(DEV_OWNER, agent.id, uidB));
    const cons = await inspJs.consumers.get(DM, dmDurable(DEV_OWNER, agent.id, uidB));
    const got: string[] = [];
    const batch = await cons.fetch({ max_messages: 5, expires: 2000 });
    for await (const m of batch) { got.push((JSON.parse(new TextDecoder().decode(m.data)) as { id: string }).id); m.ack(); }
    check("FRONTIER: successor's dm durable delivers ONLY the post-provisioning DM (dm2, never dm1)",
      got.length === 1 && got[0] === "dm2", { got, deliverPolicy: ci.config.deliver_policy, startSeq: ci.config.opt_start_seq });
  }

  // DUAL-LIVE AMBIGUITY PROBE (the panel's orphan-row gate): plant a SECOND live ACL row for the
  // alias (the shape a FAILED detached teardown leaves) and assert the alias resolver REFUSES
  // loudly (AmbiguousAclAlias) rather than first-matching a lifecycle. HONESTY: this refusal is
  // the documented degradation - the successor stays live-only until the orphan row is removed
  // by an exact-uid deprovision (no reconciler exists yet; named D30/D33 follow-up).
  {
    const { readAclForAlias, AmbiguousAclAlias, commitAcl: commitAclRow } = await import("../src/acls.js");
    const kv = await openAclRegistry(insp, space);
    const uidC = mintLifecycleUid();
    await commitAclRow(kv, localPrincipal(agent.id), uidC, ["general"]); // the orphan twin (B's row is live too)
    let refused = false, other: unknown;
    try { await readAclForAlias(kv, localPrincipal(agent.id)); }
    catch (e) { if (e instanceof AmbiguousAclAlias) refused = true; else other = e; }
    check("DUAL-LIVE: two live rows for one alias refuse loudly (AmbiguousAclAlias, never first-match)", refused, other);
    // and the refusal counts LIVE rows only: purging the planted twin restores single-row resolution.
    const { deleteAcl } = await import("../src/acls.js");
    await deleteAcl(kv, localPrincipal(agent.id), uidC);
    const resolved = await readAclForAlias(kv, localPrincipal(agent.id));
    check("DUAL-LIVE: purging the orphan restores alias resolution to the single LIVE row (uidB)",
      resolved?.lifecycleUid === uidB, resolved);

    // CREATE-AFTER-SNAPSHOT PROBE (the panel's post-scan TOCTOU gate): a successor row committed
    // AFTER the first enumeration's point-in-time key snapshot is invisible to that pass — a
    // single-pass resolver would return the lone scanned row (the predecessor) instead of
    // refusing. Interpose on the KV surface readAclForAlias uses (keys + get) and commit a twin
    // row exactly when the SECOND enumeration begins, so pass 1 sees [B] and pass 2 sees [B, D]:
    // the post-scan re-verify must surface AmbiguousAclAlias. Under the single-pass code this
    // wrapper never fires (one keys() call) and the probe FAILS by resolving B — the
    // distinguishing shape for the temp-revert proof.
    {
      const uidD = mintLifecycleUid();
      let keysCalls = 0;
      const racedKv = {
        keys: async (filter?: string) => {
          keysCalls++;
          if (keysCalls === 2) await commitAclRow(kv, localPrincipal(agent.id), uidD, ["general"]);
          return kv.keys(filter);
        },
        get: (k: string) => kv.get(k),
      } as unknown as typeof kv;
      let refusedRace = false, otherRace: unknown, leaked: string | undefined;
      try {
        const r = await readAclForAlias(racedKv, localPrincipal(agent.id));
        leaked = r?.lifecycleUid;
      } catch (e) {
        if (e instanceof AmbiguousAclAlias) refusedRace = true; else otherRace = e;
      }
      check("POST-SCAN: a successor row created after the first scan's snapshot REFUSES (AmbiguousAclAlias), never resolves the lone predecessor",
        refusedRace, otherRace ?? { leaked, keysCalls });
      const { deleteAcl: deleteAclRow } = await import("../src/acls.js");
      await deleteAclRow(kv, localPrincipal(agent.id), uidD);
      const settled = await readAclForAlias(kv, localPrincipal(agent.id));
      check("POST-SCAN: once the race settles (twin removed) the alias resolves to the single live row again",
        settled?.lifecycleUid === uidB, settled);
    }
  }
  await insp.drain().catch(() => {});

  console.log(`\nDEPROVISION SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
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
