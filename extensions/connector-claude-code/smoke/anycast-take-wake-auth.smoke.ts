/**
 * Claude Code's channel wake for role requests held for their take (SPEC §8.1), live: on a JWT-auth
 * broker with a real delivery daemon, the shipped MeshAgent and createWakePolicy count a held request
 * in a batch notice, on channel activation and on the retry after a failed push, and a hook that takes
 * and shows the held requests pushes no notice for them on top of the frame that shows them. A frame
 * whose take was refused chooses again, a run turn that lands during the take waits for the next
 * frame when it no longer fits, and a Stop wakes no turn for a request waiting out its retry.
 *
 * Run: pnpm smoke:claude-anycast-take-wake:auth   (needs `nats-server` on PATH; local-only)
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/anycast-take-wake-auth.json
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  DEV_OWNER,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
  takeServeFilter,
} from "@cotal-ai/core";
import { MeshAgent } from "../../connector-core/dist/index.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createClaudeHandle, createWakePolicy, HOOK_CONTEXT_CHARS, type WakePolicy } from "../src/hooks.js";

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `cc-take-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean, ms = 8000): Promise<void> => {
  for (const deadline = Date.now() + ms; !read() && Date.now() < deadline; ) await sleep(50);
};
const { check, finish } = createSuite();

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const stops: Array<() => Promise<unknown> | void> = [];

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provCreds });
  const mgr = new CotalEndpoint({ space, servers, creds: provCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();
  stops.push(() => mgr.stop());
  const daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {});
  daemon.on("warning", () => {});
  await daemon.start();
  const lease = await daemon.acquireDeliveryLease(0);
  await daemon.startPlane3((owner, uid) => daemon.aclForOwner(owner, uid));
  stops.push(() => daemon.stop());

  const ident = newIdentity();
  const uid = mintLifecycleUid();
  const creds = await provisionAgent(mgr, auth, ident, { subscribe: [], allowSubscribe: [], allowPublish: [], role: "reviewer", lifecycleUid: uid });
  const agent = new MeshAgent({ space, name: "cc_reviewer", role: "reviewer", servers, creds, subscribe: [], allowSubscribe: [], allowPublish: [], kind: "agent", tls: false, id: ident.id, lifecycleUid: uid });
  agent.on("error", () => {});
  agent.start();
  stops.push(() => agent.stop());
  await until(() => agent.connected, 10_000);

  const sIdent = newIdentity();
  const sUid = mintLifecycleUid();
  const sCreds = await provisionAgent(mgr, auth, sIdent, { subscribe: [], allowSubscribe: [], allowPublish: [], lifecycleUid: sUid });
  const sender = new CotalEndpoint({ space, servers, creds: sCreds, card: { name: "sender", kind: "agent", id: sIdent.id }, channels: [], lifecycleUid: sUid });
  sender.on("error", () => {});
  await sender.start();
  stops.push(() => sender.stop());

  const notices: string[] = [];
  let failNotify = false;
  let wake: WakePolicy | undefined;
  const claude = createClaudeHandle({ surfaced: (items) => wake?.surfaced(items) });
  wake = createWakePolicy(agent, async (params) => {
    if (failNotify) throw new Error("stdio pipe busy");
    notices.push(String(params.content));
  });
  stops.push(() => wake?.stop());

  // ── 1. activation counts a request held for its take ──────────────────────────────────────
  console.log("[1] channel activation counts a role request held for its take");
  await sender.anycastAttributed("reviewer", "first held request");
  await until(() => agent.inboxWake() === 1);
  check("1a the request is held: it wakes, and no read can see it yet", agent.inboxWake() === 1 && agent.peekInbox("automatic").length === 0, { wake: agent.inboxWake() });
  wake.setChannelActive(true);
  await until(() => notices.length === 1);
  check("1b activation announces the held request as one message waiting", notices.length === 1 && notices[0]!.includes("1 Cotal message waiting"), notices);

  // ── 2. the retry after a failed push counts it ────────────────────────────────────────────
  console.log("[2] the retry after a failed push counts a held request");
  notices.length = 0;
  failNotify = true;
  await sender.anycastAttributed("reviewer", "second held request");
  await until(() => agent.inboxWake() === 2);
  await sleep(100);
  failNotify = false;
  await until(() => notices.length === 1, 4000);
  check("2a the retry announces the held request the failed push missed", notices.length === 1 && notices[0]!.includes("1 Cotal message waiting"), notices);

  // ── 3. a hook that takes and shows the held requests ──────────────────────────────────────
  // Two more arrive while every push fails, so no notice announces them, and the hook runs before
  // the retry would. A take announced as an arrival would then push a notice for each.
  console.log("[3] a hook that takes and shows held requests pushes no notice for them");
  failNotify = true;
  await sender.anycastAttributed("reviewer", "third held request");
  await sender.anycastAttributed("reviewer", "fourth held request");
  await until(() => agent.inboxWake() === 4);
  failNotify = false;
  notices.length = 0;
  const ev = { hook_event_name: "UserPromptSubmit" };
  const out = JSON.stringify(await claude.handle(agent, ev));
  claude.onReply(ev, true);
  await sleep(200);
  check("3a the hook frame shows the four requests", ["first", "second", "third", "fourth"].every((n) => out.includes(`${n} held request`)), out);
  check("3b and its takes push no notice on top of it", notices.length === 0, notices);

  // The cells below give each case a seat of its own, with its own hook handle and wake policy.
  const seat = async (name: string, role: string) => {
    const ident = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(mgr, auth, ident, { subscribe: [], allowSubscribe: [], allowPublish: [], role, lifecycleUid: uid });
    const a = new MeshAgent({ space, name, role, servers, creds, subscribe: [], allowSubscribe: [], allowPublish: [], kind: "agent", tls: false, id: ident.id, lifecycleUid: uid });
    a.on("error", () => {});
    a.start();
    stops.push(() => a.stop());
    await until(() => a.connected, 10_000);
    const pushed: string[] = [];
    let policy: WakePolicy | undefined;
    const handle = createClaudeHandle({ surfaced: (items) => policy?.surfaced(items) });
    policy = createWakePolicy(a, async (params) => { pushed.push(String(params.content)); });
    stops.push(() => policy?.stop());
    policy.setChannelActive(true);
    // One hook frame and its delivered verdict; the context the frame injected.
    const frame = async (event: string): Promise<string> => {
      const e = { hook_event_name: event };
      const reply = (await handle.handle(a, e)) as { hookSpecificOutput?: { additionalContext?: string } };
      handle.onReply(e, true);
      return reply.hookSpecificOutput?.additionalContext ?? "";
    };
    return { agent: a, id: `${DEV_OWNER}.${ident.id}`, pushed, frame };
  };

  // ── 4. a refused take leaves room for the next request ────────────────────────────────────
  console.log("[4] a frame whose first request was cancelled carries the next one that fits");
  const refused = await seat("cc_refused", "refusedrole");
  const first4 = await sender.anycastAttributed("refusedrole", `first role request ${"r".repeat(5_000)}`);
  await sender.anycastAttributed("refusedrole", `second role request ${"s".repeat(4_000)}`);
  await until(() => refused.agent.inboxWake() === 2);
  await sender.cancelAnycast(first4.ack.seq);
  const frame4 = await refused.frame("UserPromptSubmit");
  check("4a the frame carries the second request in the room the cancelled one left", frame4.includes("second role request") && !frame4.includes("first role request"), frame4.slice(0, 200));

  // ── 5. a run turn that lands while the frame's take is in flight ──────────────────────────
  // The take is watched on the wire, and the turn lands as it goes out, the way a pulled turn
  // lands in the seat's cache.
  console.log("[5] a run turn that lands during the take waits for the next frame when it no longer fits");
  const turned = await seat("cc_turned", "turnedrole");
  const watchNc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, newIdentity(), "delivery"))), maxReconnectAttempts: 0 });
  stops.push(() => watchNc.close());
  let landed = false;
  const watch5 = watchNc.subscribe(takeServeFilter(space), { callback: () => {
    if (landed) return;
    landed = true;
    (turned.agent as unknown as { activeTurns: Map<string, unknown> }).activeTurns.set("goal-late", {
      goalId: "goal-late", payload: JSON.stringify({ context: `a run turn that landed during the take ${"t".repeat(600)}` }), acceptedAt: Date.now(),
    });
  } });
  await watchNc.flush();
  const sent5 = await sender.anycastAttributed("turnedrole", `role request ${"r".repeat(8_200)}`);
  await until(() => turned.agent.inboxWake() === 1);
  const frame5 = await turned.frame("UserPromptSubmit");
  check("5a the turn landed while the take was in flight", landed);
  check("5b the frame shows the request its take recorded", frame5.includes("role request") && frame5.length <= HOOK_CONTEXT_CHARS, { length: frame5.length, head: frame5.slice(0, 160) });
  check("5c and leaves the turn for the next frame", !frame5.includes("goal-late") && (await turned.frame("UserPromptSubmit")).includes("goal-late"));
  check("5d the request is acked as shown", !turned.agent.inboxKeys().includes(sent5.msg.id));
  // A watcher left subscribed would answer nothing, so a later take would wait out its timeout.
  watch5.unsubscribe();
  await watchNc.flush();

  // ── 6. a request held through a retry wait does not wake a stopped session ────────────────
  // Last, because it stops the daemon. The session answers every push with a turn: a prompt
  // frame, then Stop.
  console.log("[6] Stop wakes no turn for a role request waiting out a take nobody could decide");
  const looped = await seat("cc_looped", "loopedrole");
  await daemon.releaseDeliveryLease(0, lease).catch(() => {});
  await daemon.stop();
  await sender.anycastAttributed("loopedrole", "held while the daemon is down");
  await until(() => looped.agent.inboxWake() === 1);
  await until(() => looped.pushed.length === 1, 4000);
  const frame6 = await looped.frame("UserPromptSubmit");
  await looped.frame("Stop");
  await sleep(300);
  check("6a the frame shows nothing of the held request", !frame6.includes("held while the daemon is down"), frame6);
  check("6b the Stop after it pushes no notice, so no new turn starts", looped.pushed.length === 1, looped.pushed);
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  for (const stop of stops.reverse()) { try { await stop(); } catch { /* ignore */ } }
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
process.exit(process.exitCode ?? 0);
