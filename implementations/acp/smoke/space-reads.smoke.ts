/**
 * The bridge's reads of a real space, opened with `openLiveMesh` as `cotal acp` opens one, on a
 * static space and an open one, each on its own broker:
 *
 *  - a seat's event frames and payload frames reach the live tap, and history returns each payload
 *    frame before its event frame;
 *  - a space with no payload stream, as one set up before the payload rail, still replays the event
 *    frames;
 *  - a credential without the payload history row is refused the read the bridge makes;
 *  - when the payload history cannot be read, the thread fails to replay, saying that the seat's
 *    earlier tool inputs and results cannot be read, and why;
 *  - with no manager registered, the agent list rejects with the error that names it.
 *
 * Run: pnpm smoke:acp-space-reads (needs nats-server on PATH).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGUI_FRAME_KIND, chatSubject, CotalEndpoint, createSpaceAuth, DEV_OWNER, eventChannel, eventPayloadStream, eventPayloadSubject, isReachable, mintCreds, mintLifecycleUid, newIdentity, principalKey, serverConfig, setupSpaceStreams, spacePrefix, type SpaceAuth } from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "../../../packages/smoke-kit/src/index.js";
import { openLiveMesh } from "../src/live-mesh.js";
import type { Mesh, SeatFrame, SeatRef } from "../src/mesh.js";

// The seat publishes and the space's streams change through the raw client core depends on.
const coreRequire = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
type Nats = { close(): Promise<void> };
type StreamAdmin = { streams: { delete(name: string): Promise<boolean>; add(config: Record<string, unknown>): Promise<unknown> } };
const { connect, credsAuthenticator } = coreRequire("@nats-io/transport-node") as { connect: (o: Record<string, unknown>) => Promise<Nats>; credsAuthenticator: (creds: Uint8Array) => unknown };
const { jetstream, jetstreamManager } = coreRequire("@nats-io/jetstream") as { jetstream: (nc: Nats) => { publish(subject: string, data: Uint8Array): Promise<unknown> }; jetstreamManager: (nc: Nats) => Promise<StreamAdmin> };

const { check, finish } = createSuite();
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}acp-space-reads-`));
process.env.COTAL_HOME = join(dir, "home");
const seat: SeatRef = { name: "seat", owner: DEV_OWNER, actor: "seat", lifecycleUid: mintLifecycleUid() };

interface Space { readonly name: string; readonly server: string; readonly broker: ChildProcess; readonly release: () => void; readonly auth?: SpaceAuth }

/** A broker for one space, recorded in this suite's registry as `cotal up` records it. */
async function startSpace(name: string, auth: SpaceAuth | undefined): Promise<Space> {
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const root = join(dir, name);
  const store = join(root, "js");
  const conf = join(dir, `${name}.conf`);
  if (auth) writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: store }));
  const args = auth ? ["-c", conf] : ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", store];
  const broker = spawn(process.env.NATS_SERVER_BIN ?? "nats-server", args, { stdio: "ignore" });
  const release = teardownOnSignal(broker, dir);
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 100, delayMs: 50 });
  await setupSpaceStreams({ servers: server, space: name, ...(auth ? { creds: await mintCreds(auth, newIdentity(), "provisioner") } : {}) });
  if (auth) saveSpaceAuth(authDir(root), auth);
  recordMesh({ space: name, server, root, mode: auth ? "auth" : "open", ts: new Date().toISOString() });
  return { name, server, broker, release, ...(auth ? { auth } : {}) };
}

/** A raw connection to the space: the seat's own, or one that changes the space's streams. */
async function dial(s: Space, as: "seat" | "teardown" | "provisioner"): Promise<Nats> {
  if (!s.auth) return connect({ servers: s.server, reconnect: false });
  const identity = newIdentity();
  const creds = as === "seat"
    ? await mintCreds(s.auth, identity, "agent", { principal: { owner: seat.owner, actor: seat.actor }, lifecycleUid: seat.lifecycleUid, allowSubscribe: [], allowPublish: [eventChannel(seat)], eventPayloads: true })
    : await mintCreds(s.auth, identity, as, as === "teardown" ? { lifecycleUid: mintLifecycleUid() } : {});
  return connect({ servers: s.server, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${identity.id}`, reconnect: false });
}

function frame(s: Space, seq: number, events: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    id: `frame-${seq}-${s.name}`, space: s.name, ts: Date.now(), channel: eventChannel(seat),
    from: { id: principalKey(seat.owner, seat.actor).key, name: seat.name },
    parts: [{ kind: AGUI_FRAME_KIND, threadId: "t", runId: "r1", epoch: "e", seq, events }],
  }));
}

/** One tool call as a seat publishes it: its arguments on the payload rail, then its start event. */
async function publishCall(s: Space, nc: Nats): Promise<void> {
  const js = jetstream(nc);
  await js.publish(eventPayloadSubject(s.name, seat.owner, seat.actor), frame(s, 1, [{ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: "{\"command\":\"ls\"}" }]));
  await js.publish(chatSubject(s.name, seat.owner, seat.actor, eventChannel(seat)), frame(s, 1, [{ type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Bash" }]));
}

async function withStreams(s: Space, as: "teardown" | "provisioner", change: (jsm: StreamAdmin) => Promise<unknown>): Promise<void> {
  const nc = await dial(s, as);
  try { await change(await jetstreamManager(nc)); } finally { await nc.close(); }
}

/** The read the bridge makes for a seat's payload history, as a credential without its row. */
async function refusedRead(s: Space): Promise<Error | undefined> {
  const reader = new CotalEndpoint({ space: s.name, servers: s.server, creds: await mintCreds(s.auth!, newIdentity(), "observer", { principal: { owner: "u_bbbbbbbbbbbbbbbbbbbbbbbbbb", actor: "observer" } }),
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "reader", kind: "endpoint" } });
  await reader.start();
  try {
    return await reader.eventPayloadHistory(seat.owner, seat.actor, { limit: 10 }).then(() => undefined, (e: Error) => e);
  } finally { await reader.stop(); }
}

async function checkSpace(label: string, s: Space): Promise<void> {
  const mesh: Mesh = await openLiveMesh({ space: s.name, log: () => {}, stop: () => {} });
  const frames: SeatFrame[] = [];
  mesh.followFrames((f) => frames.push(f));
  await tick(300);
  const nc = await dial(s, "seat");
  try {
    await publishCall(s, nc);
    await tick(500);
    check(`${label}: the live tap gets the seat's payload frame`, frames.some((f) => f.plane === "payloads" && f.seq === 1), frames.map((f) => [f.plane, f.seq]));
    check(`${label}: the live tap gets the seat's event frame`, frames.some((f) => f.plane === "events" && f.seq === 1), frames.map((f) => [f.plane, f.seq]));
    const history = await mesh.frameHistory(seat).catch((e: Error) => e);
    check(`${label}: history returns the payload frame before its event frame`, Array.isArray(history) && JSON.stringify(history.map((f) => f.plane)) === '["payloads","events"]', history);
    if (s.auth) {
      const refused = await refusedRead(s);
      check(`${label}: a credential without the payload history row is refused the read`, /permissions? violation/i.test(refused?.message ?? ""), refused?.message);
    }
    await withStreams(s, "teardown", (jsm) => jsm.streams.delete(eventPayloadStream(s.name)));
    const bare = await mesh.frameHistory(seat).catch((e: Error) => e);
    check(`${label} with no payload stream: history still returns the event frame`, Array.isArray(bare) && JSON.stringify(bare.map((f) => f.plane)) === '["events"]', bare instanceof Error ? bare.message : bare);
    // A work-queue payload stream takes no reader that does not acknowledge, so it refuses the bridge's read.
    await withStreams(s, "provisioner", (jsm) => jsm.streams.add({ name: eventPayloadStream(s.name), subjects: [`${spacePrefix(s.name)}.evp.>`], retention: "workqueue" }));
    const unread = await mesh.frameHistory(seat).then(() => undefined, (e: Error) => e);
    check(`${label} when the payload history cannot be read: replay fails, saying the earlier tool inputs and results cannot be read, and why`,
      unread?.message.startsWith("seat's earlier tool inputs and results cannot be read from its payload history: ") === true && unread.message.length > 80, unread?.message);
    const none = await mesh.seats().then(() => undefined, (e: Error) => e);
    check(`${label} with no manager registered: the agent list rejects saying so, as NoManagerRegistered`,
      none?.name === "NoManagerRegistered" && none.message === `No live manager is registered for ${s.name}`, none && { name: none.name, message: none.message });
  } finally {
    await nc.close();
    await mesh.close();
  }
}

const spaces: Space[] = [];
try {
  spaces.push(await startSpace("acpstatic", await createSpaceAuth("acpstatic")));
  await checkSpace("static space", spaces[0]!);
  spaces.push(await startSpace("acpopen", undefined));
  await checkSpace("open space", spaces[1]!);
} finally {
  for (const s of spaces) {
    await killAndAwaitExit(s.broker, "SIGTERM");
    s.release();
  }
  rmSync(dir, { recursive: true, force: true });
}
finish();
