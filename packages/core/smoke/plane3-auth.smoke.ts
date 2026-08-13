/**
 * Plane-3 durable backstop (Stage-4) end-to-end against a REAL auth broker (no test runner).
 *
 * Proves the whole path the design promises: the privileged Plane-3 host (the server-side delivery
 * daemon) runs the fan-out writer + trusted reader; an agent that is a durable MEMBER of a channel but
 * is NOT live-subscribed to it receives a
 * post on its next turn via the per-member DELIVER store (`dlv_<id>`) — kind=channel, durable:true,
 * a real JetStream ack. Then the interval rules: a post after `durableLeave` (`seq > leaveCursor`) is
 * NOT delivered (leave is a hard read boundary for the backstop), and the security boundary holds —
 * the agent cannot read the mixed INBOX store, cannot publish into its own dinbox/dlv, and a peer
 * cannot bind another agent's dlv durable.
 *
 * Run: pnpm smoke:plane3:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager, jetstream, AckPolicy } from "@nats-io/jetstream";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  mintLifecycleUid,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  DEV_OWNER,
  chatSubject,
  inboxStream,
  parsePrincipalKey,
  dinboxSubject,
  dlvSubject,
  dlvDurable,
  dlvStream,
  type Delivery,
  type CotalMessage,
  type MessageMeta,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};
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
/** Run a privileged op expecting a broker denial — true when it throws. */
const denied = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

const space = `plane3-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-plane3-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // ---- privileged manager endpoint: provisioner + Plane-3 host + publisher ----
  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();

  // The former allow-all manager is split into scoped creds (PR 1.5): the provisioner endpoint (`mgr`)
  // keeps setupSpaceStreams/provisionAgent; an `operator` cred posts chat AS itself (the daemon's
  // fan-out reads CHAT and delivers). No control is served here, so no supervisor cred is needed.
  const poster = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "operator"),
    card: { name: "poster", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false,
  });
  poster.on("error", (e: Error) => console.error("  ! poster", e.message));
  await poster.start();

  // ---- agent A: boots subscribed ONLY to "general"; read ACL also covers "review". It durable-joins
  //      "review" but never live-subscribes it, so a review post can reach it ONLY via Plane-3. ----
  const aId = newIdentity();
  const uidA = mintLifecycleUid(); // alice's one lifecycle uid (SPEC §13.1)
  const aCreds = await provisionAgent(mgr, auth, aId, {
    subscribe: ["general"],
    allowSubscribe: ["general", "review"],
    lifecycleUid: uidA,
  });
  // The reader re-auths against the owner's CURRENT ACL — supply it the way the manager does from its
  // managed set. Agent B (below) is authorized for "general" only (not "review").
  const bId = newIdentity();
  const uidB = mintLifecycleUid(); // bob's one lifecycle uid (SPEC §13.1)
  // Dev/static principals: owner=DEV_OWNER ("local"), actor=the nkey. The reader re-auths against the
  // member PRINCIPAL dot-form (`local.<nkey>`), and durableJoin/LeaveFor key the members registry by it.
  const aPrincipal = `${DEV_OWNER}.${aId.id}`;
  const bPrincipal = `${DEV_OWNER}.${bId.id}`;
  const aclFor = (id: string): string[] | undefined =>
    id === aPrincipal ? ["general", "review"] : id === bPrincipal ? ["general"] : undefined;
  // Plane-3 host = the server-side delivery daemon (scoped `delivery` cred), NOT the manager — the
  // manager cred no longer carries the Plane-3 inject grants (closure (i): no `dinbox`/`dlv`/members
  // write, no `ctl.delivery`). The manager stays provisioner (provisionAgent above) + publisher (the
  // multicast calls below post chat AS the operator; the daemon's fan-out reads CHAT and delivers).
  const dlvId = newIdentity();
  const dlv = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  dlv.on("error", (e: Error) => console.error("  ! dlv", e.message));
  await dlv.start();
  await dlv.startPlane3(aclFor);

  const a = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general"], lifecycleUid: uidA, heartbeatMs: 500, ttlMs: 2000,
  });
  const got: { ch?: string; text: string; kind: string; durable: boolean }[] = [];
  const agentErrors: string[] = [];
  a.on("error", (e: Error) => console.error("  ! alice", e.message));
  a.on("error", (e: Error) => agentErrors.push(e.message));
  a.on("message", (m, d: Delivery, meta: MessageMeta) => {
    got.push({
      ch: m.channel, kind: meta.kind, durable: d.durable,
      text: m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""),
    });
    d.ack();
  });
  await a.start();
  await wait(300);

  // ---- durable join + delivery ----
  const r = await dlv.durableJoinFor(aPrincipal, "review", uidA);
  check("durableJoinFor('review') reports durable:true (record committed + reader hosted)", r.durable === true, r);

  await poster.multicast("hello-durable", { channel: "review" });
  check(
    "a durable MEMBER not live-subscribed receives the post via Plane-3 (next turn)",
    await until(() => got.some((g) => g.text === "hello-durable")),
    got,
  );
  const h = got.find((g) => g.text === "hello-durable");
  check("delivered on the right channel (review)", h?.ch === "review");
  check("kind=channel (path-derived from the DELIVER durable, not a header — SPEC §4)", h?.kind === "channel");
  check("durable:true (real JetStream backstop ack, coalesces with any live copy)", h?.durable === true);

  // The payload channel is advisory. A raw publisher cannot relabel a #review post as #general to
  // bypass connector attention after fan-out: Plane-3 carries the subject-derived channel in its
  // versioned DLV frame and the agent surfaces that value.
  const posterPrincipal = parsePrincipalKey(poster.card.id);
  if (!posterPrincipal) throw new Error(`poster has no principal: ${poster.card.id}`);
  const mismatch: CotalMessage = {
    id: randomUUID(),
    ts: Date.now(),
    space,
    from: poster.card,
    channel: "general",
    parts: [{ kind: "text", text: "plane3-subject-wins" }],
  };
  const posterJs = (poster as unknown as {
    js: { publish(subject: string, data: string, opts: { msgID: string }): Promise<unknown> };
  }).js;
  await posterJs.publish(
    chatSubject(space, posterPrincipal.owner, posterPrincipal.actor, "review"),
    JSON.stringify(mismatch),
    { msgID: mismatch.id },
  );
  check("Plane-3 surfaces the subject-authenticated channel, not the payload label", await until(() =>
    got.some((g) => g.text === "plane3-subject-wins" && g.ch === "review")), got);

  // Upgrade safety: an already-persisted pre-envelope DLV body has no authenticated original channel.
  // It must terminate loudly rather than use its payload label for automatic connector injection.
  const legacy: CotalMessage = {
    id: randomUUID(),
    ts: Date.now(),
    space,
    from: poster.card,
    channel: "general",
    parts: [{ kind: "text", text: "legacy-unversioned-dlv" }],
  };
  const dlvJs = (dlv as unknown as {
    js: { publish(subject: string, data: string, opts: { msgID: string }): Promise<unknown> };
  }).js;
  await dlvJs.publish(dlvSubject(space, DEV_OWNER, aId.id, uidA), JSON.stringify(legacy), { msgID: legacy.id });
  check("unversioned persisted DLV entries terminate loudly", await until(() =>
    agentErrors.some((message) => message.includes("unauthenticated or unversioned DLV entry terminated"))));
  check("an unversioned DLV entry never reaches the application", !got.some((g) => g.text === "legacy-unversioned-dlv"));

  // A subject-authenticated publisher can still send a schema-invalid CHAT body. The trusted writer
  // marks its DLV frame, but the recipient must terminate that one poison entry and keep pumping.
  const malformedId = randomUUID();
  await posterJs.publish(
    chatSubject(space, posterPrincipal.owner, posterPrincipal.actor, "review"),
    JSON.stringify({
      id: malformedId,
      ts: Date.now(),
      space,
      from: poster.card,
      channel: "review",
      parts: null,
    }),
    { msgID: malformedId },
  );
  check("a marked DLV frame with a malformed message terminates", await until(() =>
    agentErrors.some((message) => message.includes("malformed versioned DLV entry terminated"))));
  await poster.multicast("after-malformed-dlv", { channel: "review" });
  check("a malformed marked DLV entry does not stop later durable delivery", await until(() =>
    got.some((g) => g.text === "after-malformed-dlv")), got);

  // a second post arrives too (steady-state fan-out, seq > activationFence)
  await poster.multicast("second", { channel: "review" });
  check("steady-state fan-out delivers a later post", await until(() => got.some((g) => g.text === "second")));

  // ---- leave = hard read boundary (interval) ----
  await dlv.durableLeaveFor(aPrincipal, "review", uidA);
  await wait(150);
  const beforeLeave = got.length;
  await poster.multicast("after-leave", { channel: "review" });
  await wait(900); // settle: prove ABSENCE (can't poll for non-arrival)
  check(
    "a post AFTER leave (seq > leaveCursor) is NOT delivered — leave is a hard backstop cut",
    !got.some((g) => g.text === "after-leave"),
    got.slice(beforeLeave),
  );

  // ---- general (boot channel) is untouched: a general post still reaches A live (core-sub path) ----
  await poster.multicast("on-general", { channel: "general" });
  check("boot channel 'general' still delivers (Plane-3 is additive)", await until(() => got.some((g) => g.text === "on-general")));

  // ---- security boundary: the agent cannot reach the mixed INBOX store, nor write its own plane-3 ----
  const aNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(aCreds)),
    inboxPrefix: `_INBOX_${aId.id}`,
    maxReconnectAttempts: 0,
  });
  aNc.on?.("error", () => {});
  const aJsm = await jetstreamManager(aNc);
  const aJs = jetstream(aNc);
  check(
    "agent CANNOT create a consumer on the INBOX (mixed pre-auth) stream — fan-out target is unreadable",
    await denied(() => aJsm.consumers.add(inboxStream(space), { name: `steal_${randomUUID().slice(0, 6)}`, filter_subject: dinboxSubject(space, DEV_OWNER, aId.id, uidA), ack_policy: AckPolicy.None })),
  );
  check(
    "agent CANNOT create a consumer on the DLV stream (bind-only — create denied)",
    await denied(() => aJsm.consumers.add(dlvStream(space), { name: `make_${randomUUID().slice(0, 6)}`, filter_subject: dlvSubject(space, DEV_OWNER, aId.id, uidA), ack_policy: AckPolicy.Explicit })),
  );
  check(
    "agent CANNOT publish into its own dinbox (only the manager fans out)",
    await denied(() => aJs.publish(dinboxSubject(space, DEV_OWNER, aId.id, uidA), "forged")),
  );
  check(
    "agent CANNOT publish into its own dlv (only the trusted reader transfers)",
    await denied(() => aJs.publish(dlvSubject(space, DEV_OWNER, aId.id, uidA), "forged")),
  );
  await aNc.close();

  // ---- a peer (B) cannot bind A's DELIVER durable ----
  const bCreds = await provisionAgent(mgr, auth, bId, { subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: uidB });
  const bNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(bCreds)),
    inboxPrefix: `_INBOX_${bId.id}`,
    maxReconnectAttempts: 0,
  });
  bNc.on?.("error", () => {});
  const bJs = jetstream(bNc);
  check(
    "a peer CANNOT bind another agent's dlv_<owner> durable (name-scoped grant)",
    await denied(async () => {
      const c = await bJs.consumers.get(dlvStream(space), dlvDurable(DEV_OWNER, aId.id, uidA));
      await c.next({ expires: 1000 });
    }),
  );
  await bNc.close();

  await a.stop();
  await dlv.stop();
  await poster.stop();
  await mgr.stop();

  console.log(`\nPLANE-3 SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
