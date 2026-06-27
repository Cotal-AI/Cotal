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
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  inboxStream,
  dinboxSubject,
  dlvSubject,
  dlvDurable,
  dlvStream,
  type Delivery,
  type MessageMeta,
} from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
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
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
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
  const mgrCreds = await mintCreds(auth, mgrId, "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();

  // ---- agent A: boots subscribed ONLY to "general"; read ACL also covers "review". It durable-joins
  //      "review" but never live-subscribes it, so a review post can reach it ONLY via Plane-3. ----
  const aId = newIdentity();
  const aCreds = await provisionAgent(mgr, auth, aId, {
    subscribe: ["general"],
    allowSubscribe: ["general", "review"],
  });
  // The reader re-auths against the owner's CURRENT ACL — supply it the way the manager does from its
  // managed set. Agent B (below) is authorized for "general" only (not "review").
  const bId = newIdentity();
  const aclFor = (id: string): string[] | undefined =>
    id === aId.id ? ["general", "review"] : id === bId.id ? ["general"] : undefined;
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
    channels: ["general"], heartbeatMs: 500, ttlMs: 2000,
  });
  const got: { ch?: string; text: string; kind: string; durable: boolean }[] = [];
  a.on("error", (e: Error) => console.error("  ! alice", e.message));
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
  const r = await dlv.durableJoinFor(aId.id, "review");
  check("durableJoinFor('review') reports durable:true (record committed + reader hosted)", r.durable === true, r);

  await mgr.multicast("hello-durable", { channel: "review" });
  check(
    "a durable MEMBER not live-subscribed receives the post via Plane-3 (next turn)",
    await until(() => got.some((g) => g.text === "hello-durable")),
    got,
  );
  const h = got.find((g) => g.text === "hello-durable");
  check("delivered on the right channel (review)", h?.ch === "review");
  check("kind=channel (path-derived from the DELIVER durable, not a header — SPEC §4)", h?.kind === "channel");
  check("durable:true (real JetStream backstop ack, coalesces with any live copy)", h?.durable === true);

  // a second post arrives too (steady-state fan-out, seq > activationFence)
  await mgr.multicast("second", { channel: "review" });
  check("steady-state fan-out delivers a later post", await until(() => got.some((g) => g.text === "second")));

  // ---- leave = hard read boundary (interval) ----
  await dlv.durableLeaveFor(aId.id, "review");
  await wait(150);
  const beforeLeave = got.length;
  await mgr.multicast("after-leave", { channel: "review" });
  await wait(900); // settle: prove ABSENCE (can't poll for non-arrival)
  check(
    "a post AFTER leave (seq > leaveCursor) is NOT delivered — leave is a hard backstop cut",
    !got.some((g) => g.text === "after-leave"),
    got.slice(beforeLeave),
  );

  // ---- general (boot channel) is untouched: a general post still reaches A live (core-sub path) ----
  await mgr.multicast("on-general", { channel: "general" });
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
    await denied(() => aJsm.consumers.add(inboxStream(space), { name: `steal_${randomUUID().slice(0, 6)}`, filter_subject: dinboxSubject(space, aId.id), ack_policy: AckPolicy.None })),
  );
  check(
    "agent CANNOT create a consumer on the DLV stream (bind-only — create denied)",
    await denied(() => aJsm.consumers.add(dlvStream(space), { name: `make_${randomUUID().slice(0, 6)}`, filter_subject: dlvSubject(space, aId.id), ack_policy: AckPolicy.Explicit })),
  );
  check(
    "agent CANNOT publish into its own dinbox (only the manager fans out)",
    await denied(() => aJs.publish(dinboxSubject(space, aId.id), "forged")),
  );
  check(
    "agent CANNOT publish into its own dlv (only the trusted reader transfers)",
    await denied(() => aJs.publish(dlvSubject(space, aId.id), "forged")),
  );
  await aNc.close();

  // ---- a peer (B) cannot bind A's DELIVER durable ----
  const bCreds = await provisionAgent(mgr, auth, bId, { subscribe: ["general"], allowSubscribe: ["general"] });
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
      const c = await bJs.consumers.get(dlvStream(space), dlvDurable(aId.id));
      await c.next({ expires: 1000 });
    }),
  );
  await bNc.close();

  await a.stop();
  await dlv.stop();
  await mgr.stop();

  console.log(`\nPLANE-3 SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
