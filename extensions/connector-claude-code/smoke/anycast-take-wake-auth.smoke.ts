/**
 * Claude Code's channel wake for role requests held for their take (SPEC §8.1), live: on a JWT-auth
 * broker with a real delivery daemon, the shipped MeshAgent and createWakePolicy count a held request
 * in a batch notice, on channel activation and on the retry after a failed push, and a hook that takes
 * and shows the held requests pushes no notice for them on top of the frame that shows them.
 *
 * Run: pnpm smoke:claude-anycast-take-wake:auth   (needs `nats-server` on PATH; local-only)
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/anycast-take-wake-auth.json
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { MeshAgent } from "@cotal-ai/connector-core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createClaudeHandle, createWakePolicy, type WakePolicy } from "../src/hooks.js";

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
  await daemon.acquireDeliveryLease(0);
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
