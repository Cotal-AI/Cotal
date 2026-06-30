/**
 * Channel-registry test (open mode — no auth). Spins up its OWN nats-server and verifies the
 * registry + replay mechanism end-to-end:
 *   - registry round-trip: seed → read, effective-replay precedence, merge-on-write, validation;
 *   - replay on join: a replay channel backfills history (as `historical`), a no-replay one doesn't;
 *   - the tail drop: pre-join history on a no-replay channel is suppressed (not leaked live);
 *   - dynamic join/leave: consumers.update mid-session, idempotent re-join, can't-leave-last;
 *   - rebind: a reconnect is a pure tail resume — no re-backfill.
 * Run: pnpm smoke:channels
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import {
  CotalEndpoint, seedChannelRegistry, readChannelRegistry, effectiveReplay, effectiveDeliveryClass,
  ensureDefaultDeliveryClass, validateChannelConfig,
  isReachable, chatSubject, type CotalMessage, type Delivery, type MessageMeta,
} from "../src/index.js";

// Fresh random port per run: a fixed port means a single leaked broker (from a crashed/failed prior
// run) collides with — or serves stale JetStream state to — every subsequent run, which reads as a
// flaky gate. Randomizing isolates each run even if teardown ever leaks. Paired with an await-exit in
// `finally` (a SIGKILLed child does not release the socket synchronously) so a clean run never leaks.
const PORT = 20000 + Math.floor(Math.random() * 40000);
const servers = `nats://127.0.0.1:${PORT}`;
const space = "chansmoke";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll a condition until it holds or the timeout elapses — for "the expected messages have arrived"
 *  waits. Replaces fixed `sleep()` before positive assertions: backfill (Direct-Get) and live delivery
 *  complete in variable time under load, so a tight fixed wait flakes. Absence checks still settle via a
 *  plain sleep (you cannot poll for non-arrival). Returns the final condition value for the assertion. */
const until = async (cond: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(stepMs);
  return cond();
};
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

interface Rec { channel?: string; text: string; historical: boolean; kind?: MessageMeta["kind"] }
function recorder(name: string, id: string, channels: string[]) {
  const got: Rec[] = [];
  const ep = new CotalEndpoint({ space, servers, card: { name, kind: "agent", id }, channels });
  ep.on("error", () => {});
  ep.on("message", (m: CotalMessage, d: Delivery, meta?: MessageMeta) => {
    got.push({ channel: m.channel, text: textOf(m), historical: meta?.historical ?? false, kind: meta?.kind });
    d.ack();
  });
  return { ep, got };
}
const has = (got: Rec[], text: string) => got.filter((g) => g.text === text);

const dir = mkdtempSync(join(tmpdir(), "cotal-chan-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  // ---- registry round-trip ----
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { log: { replay: true }, incident: { replay: true }, chat: { replay: false }, review: { description: "Design critique", instructions: "Be specific." } } } });
  const reg = await readChannelRegistry({ servers, space });
  check("registry round-trips", reg.defaults?.replay === false && reg.channels?.log.replay === true && reg.channels?.review.description === "Design critique");
  check("effective replay precedence", effectiveReplay(reg.channels!.log, reg.defaults) === true && effectiveReplay(reg.channels!.review, reg.defaults) === false && effectiveReplay(undefined, undefined) === true);
  await seedChannelRegistry({ servers, space, file: { channels: { review: { description: "Critique v2" } } } });
  const reg2 = await readChannelRegistry({ servers, space });
  check("merge-on-write keeps other fields", reg2.channels?.review.description === "Critique v2" && reg2.channels?.review.instructions === "Be specific.");
  assert.throws(() => validateChannelConfig({ description: "x".repeat(1000) }), /too long/);
  check("validation rejects oversize", true);

  // ---- default delivery class written at space creation (SPEC §4: on the wire, not inferred) ----
  const dcSpace = `${space}-dc`;
  check("writes default deliveryClass when unset", (await ensureDefaultDeliveryClass({ servers, space: dcSpace, deliveryClass: "durable" })) === true);
  const dcReg = await readChannelRegistry({ servers, space: dcSpace });
  check("default deliveryClass is discoverable on the wire", dcReg.defaults?.deliveryClass === "durable" && effectiveDeliveryClass(undefined, dcReg.defaults) === "durable");
  check("idempotent re-write is a no-op", (await ensureDefaultDeliveryClass({ servers, space: dcSpace, deliveryClass: "durable" })) === false);
  check("clobber-safe: an existing class wins over the profile default", (await ensureDefaultDeliveryClass({ servers, space: dcSpace, deliveryClass: "live" })) === false
    && (await readChannelRegistry({ servers, space: dcSpace })).defaults?.deliveryClass === "durable");

  // ---- replay on join ----
  const A = new CotalEndpoint({ space, servers, card: { name: "A", kind: "agent", id: "A_pub" }, channels: ["log", "chat", "general", "incident"] });
  A.on("error", () => {});
  await A.start();
  await sleep(300);
  await A.multicast("log-hist-1", { channel: "log" });
  await A.multicast("log-hist-2", { channel: "log" });
  await A.multicast("chat-hist-1", { channel: "chat" });
  await A.multicast("incident-hist-1", { channel: "incident" });
  await sleep(300);

  const B = recorder("B", "B_join", ["log", "chat"]);
  await B.ep.start();
  check("replay channel backfills history (historical)", await until(() => B.got.filter((g) => g.channel === "log" && g.historical).length === 2));
  check("no-replay channel does not backfill", has(B.got, "chat-hist-1").length === 0);

  B.got.length = 0;
  await A.multicast("log-live-1", { channel: "log" });
  await A.multicast("chat-live-1", { channel: "chat" });
  await until(() => has(B.got, "log-live-1").length === 1 && has(B.got, "chat-live-1").length === 1);
  check("live delivery, no dup, not historical", has(B.got, "log-live-1").length === 1 && has(B.got, "log-live-1")[0].historical === false && has(B.got, "chat-live-1").length === 1);
  check("multicast is authenticated kind=channel", has(B.got, "log-live-1")[0].kind === "channel");

  // ---- kind authentication: a forged payload `to` can't masquerade as a DM (§5 regression) ----
  // Raw-publish a chat message carrying a forged `to: <B's id>` straight to A's chat subject.
  // The payload `from` is A (so it passes the endpoint's subject-binds-from authenticity guard),
  // but the DELIVERING subject is `chat.*` → B must classify it kind="channel", NEVER "dm".
  B.got.length = 0;
  {
    const nc = await connect({ servers });
    const js = jetstream(nc);
    const forged: CotalMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space,
      from: A.ref(),          // MUST be the publishing endpoint A — binds payload.from to subject sender
      channel: "log",
      to: "B_join",           // the forgery: a payload `to` pointing at B
      parts: [{ kind: "text", text: "forged-dm-probe" }],
    };
    const subject = chatSubject(space, A.card.id, "log");
    await js.publish(subject, JSON.stringify(forged), { msgID: forged.id });
    await nc.close();
  }
  await until(() => has(B.got, "forged-dm-probe").length === 1);
  const probe = has(B.got, "forged-dm-probe");
  check("forged DM is delivered to the receiver", probe.length === 1);
  check("forged DM is authenticated as kind=channel, not dm", probe[0].kind === "channel" && !probe.some((r) => r.kind === "dm"));

  // ---- dynamic join (replay) + idempotent ----
  B.got.length = 0;
  const jr = await B.ep.joinChannel("incident");
  await until(() => B.got.filter((g) => g.channel === "incident" && g.historical).length === 1);
  check("dynamic join backfills replay channel", jr.joined === true && jr.backfilled === 1 && B.got.filter((g) => g.channel === "incident" && g.historical).length === 1);
  // Open mode has no manager → no Plane-3 backstop, so a durable-class join is live-only (durable:false).
  check("re-join is a no-op", JSON.stringify(await B.ep.joinChannel("incident")) === JSON.stringify({ joined: false, backfilled: 0, durable: false }));

  // ---- dynamic join (no-replay) → tail drop suppresses pre-join history ----
  B.got.length = 0;
  await A.multicast("general-hist", { channel: "general" });
  await sleep(200);
  const jg = await B.ep.joinChannel("general");
  await sleep(400);
  check("no-replay join: no backfill + pre-join history suppressed by the drop", jg.backfilled === 0 && has(B.got, "general-hist").length === 0);
  await A.multicast("general-live", { channel: "general" });
  await until(() => has(B.got, "general-live").length === 1);
  check("live delivery works after no-replay join", has(B.got, "general-live").length === 1);

  // ---- dynamic leave ----
  B.got.length = 0;
  await B.ep.leaveChannel("chat");
  await sleep(200);
  await A.multicast("chat-after-leave", { channel: "chat" });
  await sleep(400);
  check("leave stops delivery", has(B.got, "chat-after-leave").length === 0);
  // Leaving any channel is now manager-free — just close the core-sub (there is no legacy durable to
  // refuse the leave, and no last-channel restriction).
  await B.ep.leaveChannel("incident");
  check("leaving the last channel succeeds (manager-free core-sub close)", (await B.ep.leaveChannel("general")).left === true);

  // ---- restart (a fresh endpoint instance) backfills its boot channels' replay history ----
  // Stage 5: there is no per-instance chat durable + cursor — a fresh instance re-reads its boot
  // channels' replay history as a "catching up" block. (A same-instance broker reconnect resumes live
  // without re-backfilling; see firstConnect. The durable backstop, auth, redelivers any missed window.)
  await B.ep.stop();
  await sleep(300);
  const B2 = recorder("B", "B_join", ["log"]);
  await B2.ep.start();
  await until(() => B2.got.filter((g) => g.channel === "log" && g.historical).length >= 2);
  check("a fresh instance backfills its boot channel's replay history", B2.got.filter((g) => g.channel === "log" && g.historical).length >= 2);

  // ---- restart with a CHANGED config backfills the full (replay) boot set ----
  await B2.ep.stop();
  await sleep(300);
  const B3 = recorder("B", "B_join", ["log", "incident"]); // boot set now log + incident (both have history)
  await B3.ep.start();
  await until(() => B3.got.filter((g) => g.channel === "incident" && g.historical).length >= 1 && B3.got.filter((g) => g.channel === "log" && g.historical).length >= 2);
  check("restart backfills both boot channels' replay history",
    B3.got.filter((g) => g.channel === "incident" && g.historical).length >= 1 && B3.got.filter((g) => g.channel === "log" && g.historical).length >= 2);

  // ---- native time-window backfill (Direct-Get start_time) ----
  await seedChannelRegistry({ servers, space, file: { channels: { recent: { replay: true, replayWindow: "1s" }, archive: { replay: true, replayWindow: "1h" } } } });
  await A.multicast("recent-old", { channel: "recent" });
  await A.multicast("archive-old", { channel: "archive" });
  await sleep(1500); // age both past the 1s window
  const W = recorder("W", "W_join", ["recent", "archive"]);
  await W.ep.start();
  await until(() => W.got.filter((g) => g.channel === "archive" && g.historical).length === 1);
  check("time window EXCLUDES messages older than it", has(W.got, "recent-old").length === 0);
  check("wider window INCLUDES them", W.got.filter((g) => g.channel === "archive" && g.historical).length === 1);

  // ---- wildcard subscription: [c, c.>] delivers the parent AND its subtree ----
  // Regression: `c.>` must not swallow bare `c` in the filter collapse (else the parent channel
  // stops being delivered), and joining a wildcard channel must not do a per-channel registry
  // get (`>` is an illegal KV key — `joinPolicyFresh` skips it). A flat sub gets no subtree.
  const RW = recorder("RW", "RW_wild", ["review", "review.>"]); // flat parent + whole subtree
  const RF = recorder("RF", "RF_flat", ["review"]);             // flat parent only
  await RW.ep.start();
  await RF.ep.start();
  await sleep(300);
  await A.multicast("rev-flat", { channel: "review" });
  await A.multicast("rev-sec", { channel: "review.security" });
  await A.multicast("rev-deep", { channel: "review.a.b" });
  await until(() => has(RW.got, "rev-flat").length === 1 && has(RW.got, "rev-sec").length === 1 && has(RW.got, "rev-deep").length === 1 && has(RF.got, "rev-flat").length === 1);
  check("wildcard sub keeps the flat parent (collapse didn't drop it)", has(RW.got, "rev-flat").length === 1);
  check("wildcard sub receives the subtree (review.>)", has(RW.got, "rev-sec").length === 1 && has(RW.got, "rev-deep").length === 1);
  check("flat sub gets the parent but never the subtree", has(RF.got, "rev-flat").length === 1 && RF.got.every((g) => g.channel === "review"));
  await RW.ep.stop();
  await RF.ep.stop();

  await A.stop();
  await B3.ep.stop();
  await W.ep.stop();
  console.log(`\nCHANNEL REGISTRY TESTS PASSED ✅  (${pass} checks)`);
} finally {
  // Await the broker's ACTUAL exit before cleanup — SIGKILL signals the child but does not free the
  // port synchronously; returning early (the old `await sleep(150)`) can leave the broker alive past
  // teardown, leaking it onto the port. Bounded by a timeout so teardown can never hang.
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
    srv.once("exit", () => resolve());
    setTimeout(resolve, 3000);
  });
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
