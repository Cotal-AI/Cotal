/**
 * OpenCode's native prompt and a role request held for its take (SPEC §8.1), live: on a JWT-auth
 * broker with a real delivery daemon, each adapter booted in-process against a fake OpenCode server
 * (1.x, then 2.x with a fake plugin context). A role request that arrives while a turn runs is held
 * and driven nowhere. The user's next prompt takes it and carries it, and the end of that turn acks
 * it, so no later turn carries it again. On 2.x, a turn that ends while that prompt is taking the
 * request does not drive it a second time, and a prompt the host refuses after its hook does not keep
 * the next arrival from being driven.
 *
 * Run: pnpm smoke:opencode-native-prompt-take:auth   (needs `nats-server` on PATH; local-only)
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-opencode/smoke/mutations/native-prompt-take-auth.json
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
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
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { bootPlugin, bootPlugin2, disposeInProcess, fakeOpenCode2Context, type FakeOpenCode2Context } from "./_boot-plugin.js";

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `oc-take-${randomUUID().slice(0, 8)}`;
const SID = "ses_native_take";
const SID2 = "ses_native_take2";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean, ms = 8000): Promise<boolean> => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) if (read()) return true;
  return read();
};
const { check, finish } = createSuite();

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

// The fake OpenCode server: it creates the one session and records every prompt the plugin drives,
// on 1.x's routes and on 2.x's (`{data:...}`-wrapped, no `prompt_async`).
const basic = `Basic ${Buffer.from("opencode:smoke-secret").toString("base64")}`;
const driven: string[] = [];
const driven2: string[] = [];
let session2 = false;
const oc = createServer((req, res) => {
  if (req.headers.authorization !== basic) return void res.writeHead(401).end();
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/session") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: SID }));
    if (req.method === "POST" && req.url === `/session/${SID}/prompt_async`) {
      const body = raw ? (JSON.parse(raw) as { parts?: { text?: string }[] }) : undefined;
      driven.push((body?.parts ?? []).map((p) => p.text ?? "").join("\n"));
      return void res.writeHead(204).end();
    }
    if (req.method === "POST" && req.url === "/api/session") {
      session2 = true;
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: SID2 } }));
    }
    if (req.method === "POST" && req.url === `/api/session/${SID2}/prompt`) {
      driven2.push(raw ? ((JSON.parse(raw) as { text?: string }).text ?? "") : "");
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");

const stops: Array<() => Promise<unknown>> = [];
let hooks: Awaited<ReturnType<typeof bootPlugin>> | undefined;
let ctx2: FakeOpenCode2Context | undefined;
let dispose2: (() => Promise<void>) | void = undefined;
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
  const credsFile = join(dir, "holder.creds");
  writeFileSync(credsFile, await provisionAgent(mgr, auth, ident, { subscribe: [], allowSubscribe: [], allowPublish: [], role: "reviewer", lifecycleUid: uid }), { mode: 0o600 });
  const sIdent = newIdentity();
  const sUid = mintLifecycleUid();
  const sCreds = await provisionAgent(mgr, auth, sIdent, { subscribe: [], allowSubscribe: [], allowPublish: [], lifecycleUid: sUid });
  const sender = new CotalEndpoint({ space, servers, creds: sCreds, card: { name: "sender", kind: "agent", id: sIdent.id }, channels: [], lifecycleUid: sUid });
  sender.on("error", () => {});
  await sender.start();
  stops.push(() => sender.stop());

  // The plugin scrubs its launch material at boot, so each adapter gets its own copy.
  const launchEnv = (name: string, id: string, lifecycleUid: string, role: string, creds: string): void => {
    for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
    Object.assign(process.env, {
      COTAL_NAME: name, COTAL_ID: id, COTAL_LIFECYCLE_UID: lifecycleUid, COTAL_ROLE: role, COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_CREDS: creds,
      COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${(oc.address() as { port: number }).port}`, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "smoke-secret",
    });
  };
  launchEnv("oc_reviewer", ident.id, uid, "reviewer", credsFile);
  hooks = await bootPlugin();
  await until(() => sender.getRoster().some((p) => p.card.name === "oc_reviewer"), 10_000);
  const fire = (event: unknown) => hooks!.event!({ event } as never);
  const text = "role request sent while a turn runs";
  const carries = (t: string) => t.includes(text);

  // ── 1. the user's prompt takes and carries a held role request ───────────────────────────
  console.log("[1] a native prompt takes the role requests held while a turn ran, and carries them");
  await fire({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  const sent = await sender.anycastAttributed("reviewer", text);
  await sleep(1000);
  const waiting = await sender.anycastStatus(sent.ack.seq);
  check("1a while a turn runs, the role request is held: no prompt is driven and it reads waiting", driven.length === 0 && waiting.state === "waiting", { driven, waiting });
  const native = { parts: [{ type: "text", text: "the user's own prompt" }] };
  await hooks["chat.message"]!({ sessionID: SID } as never, native as never);
  check("1b the user's next prompt carries the role request", carries(native.parts[0]!.text), native.parts[0]!.text.slice(0, 300));
  const taken = await sender.anycastStatus(sent.ack.seq);
  check("1c and its take is recorded for this seat", taken.state === "taken" && taken.taker.name === "oc_reviewer", taken);
  await fire({ type: "session.idle", properties: { sessionID: SID } });
  const again = await until(() => driven.some(carries), 2000);
  check("1d the end of that turn acks it, so no later prompt carries it again", !again, driven);
  await disposeInProcess(hooks);
  hooks = undefined;

  // ── 2. the same on 2.x, whose prompt hook OpenCode 2.x also awaits before it stores the prompt ──
  console.log("[2] on 2.x, a native prompt takes the role requests held while a turn ran, and carries them");
  const ident2 = newIdentity();
  const uid2 = mintLifecycleUid();
  const credsFile2 = join(dir, "holder2.creds");
  writeFileSync(credsFile2, await provisionAgent(mgr, auth, ident2, { subscribe: [], allowSubscribe: [], allowPublish: [], role: "auditor", lifecycleUid: uid2 }), { mode: 0o600 });
  launchEnv("oc2_auditor", ident2.id, uid2, "auditor", credsFile2);
  delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;
  ctx2 = fakeOpenCode2Context();
  dispose2 = await bootPlugin2(ctx2);
  await until(() => session2 && sender.getRoster().some((p) => p.card.name === "oc2_auditor"), 10_000);
  await sleep(200);
  const text2 = "role request sent while a 2.x turn runs";
  const carries2 = (t: string) => t.includes(text2);
  ctx2.feed({ type: "session.execution.started", durable: { aggregateID: SID2, seq: 1 }, data: { sessionID: SID2 } });
  const sent2 = await sender.anycastAttributed("auditor", text2);
  await sleep(1000);
  const waiting2 = await sender.anycastStatus(sent2.ack.seq);
  check("2a on 2.x, while a turn runs, the role request is held: no prompt is driven and it reads waiting", driven2.length === 0 && waiting2.state === "waiting", { driven2, waiting2 });
  const prompt2 = ctx2.sessionHooks.get("prompt") as (e: { sessionID: string; messageID: string; prompt: { text: string } }) => void | Promise<void>;
  const native2 = { sessionID: SID2, messageID: "msg_native", prompt: { text: "the user's own prompt" } };
  await prompt2(native2);
  check("2b on 2.x, the user's next prompt carries the role request", carries2(native2.prompt.text), native2.prompt.text.slice(0, 300));
  const taken2 = await sender.anycastStatus(sent2.ack.seq);
  check("2c and its take is recorded for this seat", taken2.state === "taken" && taken2.taker.name === "oc2_auditor", taken2);
  ctx2.feed({ type: "session.execution.succeeded", durable: { aggregateID: SID2, seq: 2 }, data: { sessionID: SID2 } });
  const again2 = await until(() => driven2.some(carries2), 2000);
  check("2d the end of that turn acks it, so no later prompt carries it again", !again2, driven2);

  // A turn that ends while the user's prompt is taking a held request wakes a drive that waits on the
  // same take. The prompt's read resumes first and carries the request, so the drive must stand down.
  console.log("[3] on 2.x, a turn that ends while the user's prompt takes a held request leaves it to that prompt");
  ctx2.feed({ type: "session.execution.started", durable: { aggregateID: SID2, seq: 3 }, data: { sessionID: SID2 } });
  const text3 = "role request sent before a 2.x turn ends";
  const sent3 = await sender.anycastAttributed("auditor", text3);
  await sleep(1000);
  const before3 = driven2.length;
  const native3 = { sessionID: SID2, messageID: "msg_native3", prompt: { text: "the user's prompt as the turn ends" } };
  const hooked3 = prompt2(native3);
  ctx2.feed({ type: "session.execution.succeeded", durable: { aggregateID: SID2, seq: 4 }, data: { sessionID: SID2 } });
  await hooked3;
  await sleep(1500);
  const driven3 = driven2.slice(before3).filter((t) => t.includes(text3));
  check(
    "3a the user's prompt carries the request and no driven prompt carries it again",
    native3.prompt.text.includes(text3) && driven3.length === 0,
    { native: native3.prompt.text.slice(0, 300), driven3, status: await sender.anycastStatus(sent3.ack.seq) },
  );

  // OpenCode 2.x runs the prompt hook before it reads the prompt's attachments and skills, and refuses
  // the prompt when one is missing, so that prompt never runs and nothing ends the batch it carried.
  // The host here never starts the prompt above.
  const text4 = "role request sent after the host refused the user's prompt";
  const sent4 = await sender.anycastAttributed("auditor", text4);
  const drove4 = await until(() => driven2.some((t) => t.includes(text4)), 5000);
  check(
    "3b after the host refuses that prompt, the next role request is driven with the batch the prompt carried",
    drove4 && driven2.some((t) => t.includes(text4) && t.includes(text3)),
    { driven: driven2.slice(before3), status: await sender.anycastStatus(sent4.ack.seq) },
  );
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  await disposeInProcess(hooks).catch(() => {});
  await dispose2?.().catch(() => {});
  ctx2?.end();
  for (const stop of stops.reverse()) { try { await stop(); } catch { /* ignore */ } }
  oc.close();
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
process.exit(process.exitCode ?? 0);
