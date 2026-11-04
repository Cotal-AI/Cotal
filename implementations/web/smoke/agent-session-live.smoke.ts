/**
 * One agent's event plane, served on demand: the live half, against a real broker and the shipped
 * `web` entry point.
 *
 * An agent publishes frames on its own event channel the way the connector's emitter does: a chat
 * message on `events.<owner>.<actor>` whose one part is an `ag-ui.frame`. Two browser feeds are
 * open. Only the feed that watches the agent receives its frames, as `agent-frame`, and neither ever
 * receives them as `message`. After `unwatch` the next frame reaches nobody. Ordinary chat still
 * reaches both feeds. The events route reads the newest page of the agent's channel, only what the
 * agent itself published there, and a broker refusal of that read is an answer rather than an error.
 *
 * ORDER IS THE BARRIER, NOT TIME. "Received nothing" cannot be proved by waiting. Every negative
 * cell publishes a chat marker from the same connection after the frame in question and waits for
 * the marker to reach the feed. The observer's tap is one subscription and the publisher one
 * connection, so the marker cannot arrive before the frame did.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:web-agent-session-live
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, eventChannel, isReachable, newIdentity, setupSpaceStreams, type CotalMessage, type Part } from "@cotal-ai/core";
import { PortInUseError, SMOKE_BROKER_TOKEN, freePort, onFreePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MAX_HISTORY_LIMIT } from "../src/web.js";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) {
    console.log(`  ok ${name}`);
    return;
  }
  failed++;
  console.log(`  x FAIL ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls until `cond` holds or `ms` passes, and says which. */
const until = async (cond: () => boolean, ms = 10_000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (cond()) return true;
  return cond();
};

type Ev = { event: string; data: Record<string, unknown> };
/** One browser feed: every named SSE event it received, in order, decoded. */
const openFeed = (url: string, cookie: string): { events: Ev[]; close(): void } => {
  const ac = new AbortController();
  const events: Ev[] = [];
  void (async () => {
    const r = await fetch(url, { headers: { cookie }, signal: ac.signal });
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice("event: ".length);
          else if (line.startsWith("data: ")) data.push(line.slice("data: ".length));
        }
        // A `: ping` comment has no data and is not an event.
        if (data.length > 0) events.push({ event, data: JSON.parse(data.join("\n")) });
      }
    }
  })().catch(() => {});
  return { events, close: () => ac.abort() };
};
/** The ids of the messages a feed received as `event`. */
const idsOf = (feed: { events: Ev[] }, event: string): string[] =>
  feed.events.filter((e) => e.event === event).map((e) => (e.data.msg as CotalMessage | undefined)?.id ?? "");

type Answer = { status: number; body: string } | null;
const call = async (url: string, cookie: string, method = "GET"): Promise<Answer> => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20_000);
  try {
    const r = await fetch(url, { method, headers: { cookie }, signal: ac.signal });
    return { status: r.status, body: await r.text() };
  } catch { return null; } finally { clearTimeout(t); }
};
const parsed = (a: Answer): Record<string, unknown> => {
  try { return JSON.parse(a?.body ?? "") as Record<string, unknown>; } catch { return {}; }
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "agentsession";
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
const webs: ReturnType<typeof spawn>[] = [];
const feedsOpen: { close(): void }[] = [];
let agent: CotalEndpoint | undefined;
let mallory: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const runWeb = fileURLToPath(new URL("./run-web.mts", import.meta.url));
  const bootWeb = (env: Record<string, string> = {}): Promise<{ cookie: string; base: string }> => onFreePort(async (port) => {
    const ch = spawn(process.execPath, ["--import", "tsx", runWeb, "--space", SPACE, "--server", SERVER,
      "--port", String(port), "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    webs.push(ch);
    let log = "";
    ch.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
    ch.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
    const taken = `Port ${port} is in use`;
    let launchUrl: string | undefined;
    for (let i = 0; i < 200 && launchUrl === undefined && !log.includes(taken); i++) {
      launchUrl = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+/)?.[0];
      await wait(250);
    }
    if (launchUrl === undefined && log.includes(taken)) throw new PortInUseError(port, log);
    const exchange = launchUrl === undefined ? undefined : await fetch(launchUrl, { redirect: "manual" }).catch(() => undefined);
    const session = /(?:^|,\s*)cotal_web_session=([^;]+)/.exec(exchange?.headers.get("set-cookie") ?? "")?.[1];
    if (exchange?.status !== 302 || session === undefined) throw new Error(`web launch failed: ${log.slice(-300)}`);
    return { cookie: `cotal_web_session=${session}`, base: `http://127.0.0.1:${port}` };
  });
  const web = await bootWeb();
  const W = web.base;

  // The agent, publishing as its own principal on an open mesh.
  agent = new CotalEndpoint({ space: SPACE, servers: SERVER, channels: [], consume: false, registerPresence: false,
    card: { id: newIdentity().id, name: "engine", kind: "agent" } });
  agent.on("error", () => {});
  await agent.start();
  const AGENT_ID = agent.card.id;
  const EVENTS = eventChannel(agent.principal);
  const AGENT_PATH = encodeURIComponent(AGENT_ID);
  let seq = 0;
  /** One frame on the agent's event channel, shaped as the connector's emitter publishes it. */
  const publishFrame = (): Promise<CotalMessage> => {
    seq++;
    const frame = {
      kind: "ag-ui.frame",
      protocol: "ag-ui/0.0.57",
      threadId: "T1",
      runId: "R1",
      epoch: "E1",
      seq,
      events: [{ type: "TEXT_MESSAGE_CONTENT", messageId: `p${seq}`, delta: `step ${seq}` }],
    };
    return agent!.multicast("", { channel: EVENTS, parts: [frame as unknown as Part] });
  };
  let marks = 0;
  /** A chat message after everything published so far, and a wait for it to reach both feeds. */
  const barrier = async (feeds: { events: Ev[] }[]): Promise<boolean> => {
    const mark = await agent!.multicast(`mark ${++marks}`, { channel: "team" });
    return until(() => feeds.every((f) => idsOf(f, "message").includes(mark.id)));
  };

  // ── 1. every feed is named first ──────────────────────────────────────────────────────────────
  console.log("1. every feed opens with a hello naming it");
  const A = openFeed(`${W}/feed`, web.cookie);
  const B = openFeed(`${W}/feed`, web.cookie);
  feedsOpen.push(A, B);
  await until(() => A.events.some((e) => e.event === "roster") && B.events.some((e) => e.event === "roster"));
  ok("1.1 the first event on every feed is hello, before the roster",
    A.events[0]?.event === "hello" && B.events[0]?.event === "hello" && A.events[1]?.event === "roster",
    [A.events.slice(0, 2).map((e) => e.event), B.events.slice(0, 2).map((e) => e.event)]);
  const feedA = String(A.events[0]?.data.feed ?? "");
  const feedB = String(B.events[0]?.data.feed ?? "");
  ok("1.2 each feed has its own id", feedA !== "" && feedB !== "" && feedA !== feedB, { feedA, feedB });

  // ── 2. only the watching feed receives the agent's frames ─────────────────────────────────────
  console.log("2. a watched agent's frames reach the feed that watches it, and no other");
  const watch = await call(`${W}/api/agents/${AGENT_PATH}/watch?feed=${encodeURIComponent(feedA)}`, web.cookie, "POST");
  ok("2.1 a watch answers 204 with no body", watch?.status === 204 && watch.body === "", watch);
  const again = await call(`${W}/api/agents/${AGENT_PATH}/watch?feed=${encodeURIComponent(feedA)}`, web.cookie, "POST");
  ok("2.2 watching again is still 204", again?.status === 204, again);
  const frames = [await publishFrame(), await publishFrame(), await publishFrame()];
  const frameIds = frames.map((m) => m.id);
  const settled = await barrier([A, B]);
  ok("2.3 control: the barrier reached both feeds, so the cells below are about order and not time", settled);
  const toA = A.events.filter((e) => e.event === "agent-frame");
  ok("2.4 a feed that watches the agent receives each frame as agent-frame, with the agent's id, once and in order",
    JSON.stringify(toA.map((e) => (e.data.msg as CotalMessage).id)) === JSON.stringify(frameIds)
      && toA.every((e) => e.data.id === AGENT_ID && Object.keys(e.data).sort().join() === "id,msg"),
    toA.map((e) => ({ id: e.data.id, msg: (e.data.msg as CotalMessage).id })));
  ok("2.5 and never as message", frameIds.every((id) => !idsOf(A, "message").includes(id)), idsOf(A, "message"));
  ok("2.6 a second feed that does not watch receives nothing for the agent",
    !B.events.some((e) => e.event === "agent-frame") && frameIds.every((id) => !idsOf(B, "message").includes(id)),
    B.events.map((e) => e.event));

  // ── 3. ordinary chat still reaches everyone ───────────────────────────────────────────────────
  console.log("3. a chat message on an ordinary channel still reaches both feeds as message");
  const chat = await agent.multicast("hello team", { channel: "team" });
  await until(() => idsOf(A, "message").includes(chat.id) && idsOf(B, "message").includes(chat.id));
  ok("3.1 a chat message on an ordinary channel reaches both feeds as message",
    idsOf(A, "message").includes(chat.id) && idsOf(B, "message").includes(chat.id));
  const asMessage = A.events.find((e) => e.event === "message" && (e.data.msg as CotalMessage).id === chat.id);
  ok("3.2 with today's fields: the mode, the verified sender and the policed channel",
    asMessage?.data.mode === "chat" && asMessage.data.senderId === AGENT_ID && asMessage.data.channel === "team", asMessage?.data);

  // ── 4. the events route ───────────────────────────────────────────────────────────────────────
  console.log("4. the events route reads the newest page of the agent's channel");
  const two = await call(`${W}/api/agents/${AGENT_PATH}/events?limit=2`, web.cookie);
  const twoBody = parsed(two);
  ok("4.1 ?limit=2 over three frames answers the newest two, oldest first, more: true",
    two?.status === 200 && twoBody.more === true
      && JSON.stringify((twoBody.frames as CotalMessage[] | undefined)?.map((m) => m.id)) === JSON.stringify(frameIds.slice(1)),
    { status: two?.status, body: two?.body.slice(0, 300) });
  const all = await call(`${W}/api/agents/${AGENT_PATH}/events?limit=200`, web.cookie);
  const allBody = parsed(all);
  ok("4.2 ?limit=200 answers all three, more: false",
    all?.status === 200 && allBody.more === false
      && JSON.stringify((allBody.frames as CotalMessage[] | undefined)?.map((m) => m.id)) === JSON.stringify(frameIds),
    { status: all?.status, body: all?.body.slice(0, 300) });
  const dflt = parsed(await call(`${W}/api/agents/${AGENT_PATH}/events`, web.cookie));
  ok("4.3 with no limit the route reads its default page, which holds all three", (dflt.frames as unknown[] | undefined)?.length === 3, dflt);
  const over = await call(`${W}/api/agents/${AGENT_PATH}/events?limit=${MAX_HISTORY_LIMIT + 1}`, web.cookie);
  ok(`4.4 ?limit=${MAX_HISTORY_LIMIT + 1} is a 400 naming the ceiling`,
    over?.status === 400 && String(parsed(over).error ?? "").includes(`${MAX_HISTORY_LIMIT} messages`), over);
  const notAnId = await call(`${W}/api/agents/abc/events`, web.cookie);
  ok("4.5 /api/agents/abc/events is a 400: abc is not an agent id", notAnId?.status === 400 && notAnId.body.includes("abc"), notAnId);
  const posted = await call(`${W}/api/agents/${AGENT_PATH}/events?limit=2`, web.cookie, "POST");
  ok("4.6 any method but GET on the events route is a 405 saying GET only, and no read",
    posted?.status === 405 && parsed(posted).error === "GET only" && !("frames" in parsed(posted)), posted);

  // ── 5. watch refusals ─────────────────────────────────────────────────────────────────────────
  console.log("5. a watch names a feed that is open");
  const unknown = await call(`${W}/api/agents/${AGENT_PATH}/watch?feed=not-a-feed`, web.cookie, "POST");
  ok("5.1 a watch with an unknown feed is a 400 naming it", unknown?.status === 400 && unknown.body.includes("not-a-feed"), unknown);
  const missing = await call(`${W}/api/agents/${AGENT_PATH}/watch`, web.cookie, "POST");
  ok("5.2 a watch with no feed is a 400 naming the parameter", missing?.status === 400 && missing.body.includes("feed"), missing);
  const badAgent = await call(`${W}/api/agents/a-b.c/watch?feed=${encodeURIComponent(feedB)}`, web.cookie, "POST");
  ok("5.3 a watch for something that is not an agent id is a 400", badAgent?.status === 400, badAgent);

  // ── 6. unwatch ────────────────────────────────────────────────────────────────────────────────
  console.log("6. after unwatch, the agent's frames reach no feed");
  const unwatch = await call(`${W}/api/agents/${AGENT_PATH}/unwatch?feed=${encodeURIComponent(feedA)}`, web.cookie, "POST");
  ok("6.1 an unwatch answers 204", unwatch?.status === 204, unwatch);
  const after = await publishFrame();
  const afterSettled = await barrier([A, B]);
  ok("6.2 after unwatch, the next frame reaches no feed",
    afterSettled && [A, B].every((f) => !idsOf(f, "agent-frame").includes(after.id) && !idsOf(f, "message").includes(after.id)),
    { settled: afterSettled, a: idsOf(A, "agent-frame"), b: idsOf(B, "agent-frame") });
  const notWatched = await call(`${W}/api/agents/${AGENT_PATH}/unwatch?feed=${encodeURIComponent(feedB)}`, web.cookie, "POST");
  ok("6.3 unwatching what is not watched is 204", notWatched?.status === 204, notWatched);

  // ── 7. a refusal is an answer ─────────────────────────────────────────────────────────────────
  console.log("7. a broker refusal of the events read is an answer, with no grant on an open mesh");
  const refusing = await bootWeb({ COTAL_WEB_SMOKE_REFUSE_EVENTS: "1" });
  const refused = await call(`${refusing.base}/api/agents/${AGENT_PATH}/events`, refusing.cookie);
  const refusedBody = parsed(refused);
  ok("7.1 the route answers 200 { refused } holding the broker's text, and no grant on this open mesh",
    refused?.status === 200 && String(refusedBody.refused ?? "").includes(`Permissions Violation for Subscription to`)
      && String(refusedBody.refused ?? "").includes(EVENTS) && !("grant" in refusedBody) && !("frames" in refusedBody),
    refused);
  const control = await call(`${refusing.base}/api/channels/team/history`, refusing.cookie);
  ok("7.2 control: the same server still reads an ordinary channel, so 7.1 is the refusal and not a broken server",
    control?.status === 200, control);

  // ── 8. history is sender-checked ──────────────────────────────────────────────────────────────
  console.log("8. a frame another principal published on the agent's channel is not in its history");
  // On this open mesh anyone may publish on the agent's event channel. The live feed drops such a
  // frame (see the pure suite's 1.10); the history read must not hand it back either.
  mallory = new CotalEndpoint({ space: SPACE, servers: SERVER, channels: [], consume: false, registerPresence: false,
    card: { id: newIdentity().id, name: "mallory", kind: "agent" } });
  mallory.on("error", () => {});
  await mallory.start();
  const forged = await mallory.multicast("", { channel: EVENTS, parts: [{ kind: "ag-ui.frame", events: [{ type: "RUN_STARTED" }] } as unknown as Part] });
  await barrier([A, B]);
  const stored = parsed(await call(`${W}/api/channels/${encodeURIComponent(EVENTS)}/history?limit=200`, web.cookie)) as unknown;
  const storedIds = Array.isArray(stored) ? (stored as CotalMessage[]).map((m) => m.id) : [];
  ok("8.1 control: the broker stored the forged frame on the agent's event channel, so its absence below is the check",
    storedIds.includes(forged.id), storedIds);
  const history = parsed(await call(`${W}/api/agents/${AGENT_PATH}/events?limit=200`, web.cookie));
  const historyIds = ((history.frames as CotalMessage[] | undefined) ?? []).map((m) => m.id);
  ok("8.2 the events route reads only the frames the agent published: the forged one is absent and the agent's own are all there",
    !historyIds.includes(forged.id) && JSON.stringify(historyIds) === JSON.stringify([...frameIds, after.id]),
    { historyIds, forged: forged.id });
} finally {
  for (const f of feedsOpen) f.close();
  await mallory?.stop().catch(() => {});
  await agent?.stop().catch(() => {});
  for (const w of webs) w.kill("SIGKILL");
  release(); broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}
console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells - failed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
