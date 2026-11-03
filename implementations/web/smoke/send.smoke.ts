/**
 * POSTING FROM THE DASHBOARD: `POST /api/send`, as the one operator the process holds.
 *
 * Section 1 drives the route's refusals that need a poster in a state a live dashboard does not
 * reach on demand (expired, stopped, failing to start) through `sendAsOperator` with an injected
 * poster. Sections 2 and 3 run the SHIPPED `web` entry point (`run-web.mts`) against real brokers,
 * with one connected test endpoint subscribed to `#review` and holding a DM inbox: an open mesh,
 * then a static-auth mesh recorded in a scratch registry and the same mesh through a raw `--creds`
 * file. Section 3 is the split-thread repro the operator credential exists to fix: two DMs and the
 * agent's reply land in one conversation, grouped by the client's own `dmPeers`. Section 4 is the refusals every
 * mesh gives, against the open dashboard.
 *
 * A broker refusal is forced with `run-web.mts`'s `COTAL_WEB_SMOKE_REFUSE_TEXT` seam, which refuses
 * a publish carrying one marker text and leaves every other post alone.
 *
 * COTAL_HOME and XDG_CONFIG_HOME are scratch, and every child runs from a scratch directory, so no
 * lookup reaches the operator's own `~/.cotal`. Kills only the processes it spawns. Needs
 * nats-server on PATH. Run: pnpm smoke:web-send
 */
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PortInUseError, SMOKE_BROKER_TOKEN, freePort, onFreePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { dmPeers } from "../client/src/lib/dms.js";

const base = mkdtempSync(join(tmpdir(), "cotal-send-"));
const home = join(base, "home");
const xdg = join(base, "xdg");
const work = join(base, "work");
for (const d of [home, xdg, work]) mkdirSync(d, { recursive: true });
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = xdg;
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";

const { CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, probeConnect, provisionAgent, seedChannelRegistry, serverConfig, setupSpaceStreams } =
  await import("@cotal-ai/core");
type CotalMessage = import("@cotal-ai/core").CotalMessage;
const { authDir, recordMesh, saveSpaceAuth } = await import("@cotal-ai/workspace");
const { BadRequest, BrokerRefused, POSTER_STOPPED, POST_OFF_CREDS, POST_OFF_EXPIRED, sendAsOperator } = await import("../src/web.js");
type OperatorPoster = import("../src/web.js").OperatorPoster;

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) { console.log(`  ok ${name}`); return; }
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(probe: () => Promise<T | undefined> | T | undefined, tries = 60): Promise<T | undefined> => {
  for (let i = 0; i < tries; i++) {
    const v = await probe();
    if (v !== undefined) return v;
    await wait(150);
  }
  return undefined;
};
/** Built at runtime, never typed into this file, so the source stays reviewable by eye. */
const RLO = String.fromCodePoint(0x202e);
/** The text the refusal seam refuses. */
const REFUSE = "refuse-this-post";

interface Web { child: ChildProcess; port: number; cookie: string; log: () => string }
type Row = { card: { id: string; name?: string; role?: string }; status: string };
type Answer = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: Record<string, unknown> | undefined };

const kids: ChildProcess[] = [];
const releases: Array<() => void> = [];
const stores: string[] = [];
const endpoints: Array<{ stop(): Promise<void> }> = [];

/** One `cotal web` child, signed in through its own launch link, from the scratch directory. */
async function startWeb(args: string[], env: Record<string, string> = {}): Promise<Web> {
  let log = "";
  let launchUrl: string | undefined;
  let child: ChildProcess | undefined;
  const port = await onFreePort(async (p) => {
    child = spawn(process.execPath, [
      "--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./run-web.mts", import.meta.url)),
      ...args, "--port", String(p), "--no-open",
    ], { cwd: work, env: { ...process.env, NO_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    kids.push(child);
    child.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
    const taken = `Port ${p} is in use`;
    for (let i = 0; i < 200 && launchUrl === undefined && !log.includes(taken) && child.exitCode === null; i++) {
      launchUrl = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+/)?.[0];
      await wait(250);
    }
    if (launchUrl === undefined && log.includes(taken)) throw new PortInUseError(p, log);
    return p;
  });
  const exchange = launchUrl === undefined ? undefined : await fetch(launchUrl, { redirect: "manual" }).catch(() => undefined);
  const session = /(?:^|,\s*)cotal_web_session=([^;]+)/.exec(exchange?.headers.get("set-cookie") ?? "")?.[1];
  return { child: child!, port, cookie: `cotal_web_session=${session}`, log: () => log };
}
const stopWeb = async (w: Web) => {
  w.child.kill("SIGTERM");
  for (let i = 0; i < 40 && w.child.exitCode === null && w.child.signalCode === null; i++) await wait(100);
  if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL");
};

/** One HTTP request over `node:http`, which sends an `Origin` header as given and reports the
 *  response headers, both of which this suite reads. */
function call(w: Web, method: string, path: string, opts: { body?: string; headers?: Record<string, string>; cookie?: boolean } = {}): Promise<Answer> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1", port: w.port, path, method, agent: false,
      headers: {
        ...(opts.cookie === false ? {} : { cookie: w.cookie }),
        ...(opts.body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(opts.body)) } : {}),
        ...opts.headers,
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => { text += d; });
      res.on("end", () => {
        let json: Record<string, unknown> | undefined;
        try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, text: `request error: ${e.message}`, json: undefined }));
    req.end(opts.body);
  });
}
const send = (w: Web, body: unknown) => call(w, "POST", "/api/send", { body: JSON.stringify(body) });
const getJson = async (w: Web, path: string): Promise<unknown> => (await call(w, "GET", path)).json;

/** The text parts of a message, joined. */
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

async function startBroker(args: (store: string) => string[], server: string, creds?: string): Promise<void> {
  const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  stores.push(store);
  const broker = spawn("nats-server", args(store), { stdio: "ignore" });
  kids.push(broker);
  releases.push(teardownOnSignal(broker, store));
  for (let i = 0; i < 80; i++) {
    const p = creds ? await probeConnect(server, { creds, timeoutMs: 400 }) : { ok: await isReachable(server) };
    if (p.ok) return;
    await wait(150);
  }
  throw new Error(`nats-server did not start at ${server}`);
}

try {
  // ---- 1. the refusals that need a poster in a given state ---------------------------------------
  console.log("1. the refusals that need a poster in a given state");
  let ensured = 0;
  const poster = (over: Partial<OperatorPoster>): OperatorPoster => ({
    operatorId: () => "local.operator",
    ensure: async () => { ensured++; throw new Error("the poster was started"); },
    expired: () => false,
    stop: async () => {},
    ...over,
  });
  const msgBody = async () => ({ kind: "msg", channel: "review", text: "hello" });
  const outcome = (p: OperatorPoster, body: () => Promise<unknown> = msgBody) =>
    sendAsOperator({ mode: "participant" }, p, () => true, body).then((r) => r as { status: number; body: Record<string, unknown> }, (e: unknown) => ({ thrown: e }));

  const expired = await outcome(poster({ expired: () => true }));
  ok("1.1 an expired operator credential refuses the post with 403 and POST_OFF_EXPIRED, before the poster starts",
    "status" in expired && expired.status === 403 && expired.body.error === POST_OFF_EXPIRED && ensured === 0, { expired, ensured });
  const stopped = await outcome(poster({ ensure: async () => { throw new Error(POSTER_STOPPED); } }));
  ok("1.2 a post after the poster stopped answers 503 with POSTER_STOPPED",
    "status" in stopped && stopped.status === 503 && stopped.body.error === POSTER_STOPPED, stopped);
  const refusedStart = await outcome(poster({ ensure: async () => { throw new Error("Authorization Violation"); } }));
  ok("1.3 an operator that cannot start is a broker refusal, carrying the broker's message",
    "thrown" in refusedStart && refusedStart.thrown instanceof BrokerRefused && refusedStart.thrown.message === "Authorization Violation",
    { thrown: "thrown" in refusedStart ? String(refusedStart.thrown) : refusedStart });
  const unreadable = await outcome(poster({ ensure: async () => { throw new Error(`Authorization Violation for ${RLO}x`); } }));
  ok("1.5 the refusal of an operator that cannot start escapes what it quotes, keeping the broker's wording",
    "thrown" in unreadable && unreadable.thrown instanceof BrokerRefused && unreadable.thrown.message === "Authorization Violation for \\u202ex",
    { thrown: "thrown" in unreadable ? String(unreadable.thrown) : unreadable });
  ensured = 0;
  const early = await outcome(poster({}), async () => ({ kind: "msg", channel: "review.*", text: "hello" }));
  ok("1.4 a refused request never starts the poster, so the operator does not join the roster for a post that did not go out",
    "thrown" in early && early.thrown instanceof BadRequest && ensured === 0, { early: "thrown" in early ? String(early.thrown) : early, ensured });

  // ---- 2. an open mesh ---------------------------------------------------------------------------
  console.log("2. an open mesh");
  const openPort = await freePort();
  const OPEN = `nats://127.0.0.1:${openPort}`;
  await startBroker((s) => ["-p", String(openPort), "-js", "-sd", s, "-a", "127.0.0.1"], OPEN);
  await setupSpaceStreams({ servers: OPEN, space: "sendopen" });
  const openGot: CotalMessage[] = [];
  const openBot = new CotalEndpoint({ space: "sendopen", servers: OPEN, card: { name: "bot", kind: "agent" }, channels: ["review"], heartbeatMs: 500, ttlMs: 5000 });
  openBot.on("error", () => {});
  openBot.on("message", (m: CotalMessage, d?: { ack?: () => void }) => { openGot.push(m); d?.ack?.(); });
  await openBot.start();
  endpoints.push(openBot);
  const openWeb = await startWeb(["--server", OPEN, "--space", "sendopen"], { COTAL_WEB_SMOKE_REFUSE_TEXT: REFUSE });
  const served = await getJson(openWeb, "/api/meta");
  ok("2.0 the shipped `web` entry point serves on the open mesh", served !== undefined, openWeb.log().slice(-400));
  const botOnRoster = await until(async () => (((await getJson(openWeb, "/api/roster")) ?? []) as Row[]).some((r) => r.card.id === openBot.card.id) || undefined);

  const posted = await send(openWeb, { kind: "msg", channel: "review", text: "hello @bot and @Ops.team" });
  const arrived = await until(() => openGot.find((m) => textOf(m) === "hello @bot and @Ops.team"));
  ok("2.1 a channel post answers 200 and reaches the subscriber from the operator",
    posted.status === 200 && posted.json?.ok === true && typeof posted.json?.id === "string"
    && arrived !== undefined && arrived.channel === "review" && arrived.from.name === "operator" && arrived.id === posted.json?.id,
    { posted: posted.text, arrived });
  ok("2.2 the post carries the @mentions in its text, as the wake hint",
    arrived !== undefined && JSON.stringify(arrived.mentions) === JSON.stringify(["bot", "ops.team"]), arrived?.mentions);
  const operatorId = posted.json?.operatorId;
  const operatorRow = await until(async () => (((await getJson(openWeb, "/api/roster")) ?? []) as Row[])
    .find((r) => r.card.id === operatorId && r.card.name === "operator" && r.status !== "offline"));
  const openMeta = (await getJson(openWeb, "/api/meta")) as Record<string, unknown> | undefined;
  ok("2.3 after it, /api/roster lists the operator and /api/meta reports the operatorId the post answered with",
    typeof operatorId === "string" && operatorRow !== undefined && openMeta?.operatorId === operatorId && arrived?.from.id === operatorId,
    { operatorId, operatorRow, openMeta });

  const refusedMsg = await send(openWeb, { kind: "msg", channel: "review", text: REFUSE });
  ok("2.4 a channel post the broker refuses answers 502 with the broker's message",
    refusedMsg.status === 502 && refusedMsg.json?.error === `Permissions Violation for Publish (${REFUSE})`, refusedMsg.text);
  const refusedDm = await send(openWeb, { kind: "dm", to: openBot.card.id, text: REFUSE });
  ok("2.5 a DM the broker refuses answers 502 with the broker's message",
    botOnRoster === true && refusedDm.status === 502 && refusedDm.json?.error === `Permissions Violation for Publish (${REFUSE})`,
    { botOnRoster, refusedDm: refusedDm.text });

  // ---- 3. a static-auth mesh ---------------------------------------------------------------------
  console.log("3. a static-auth mesh");
  const SPACE = "sendstatic";
  const root = join(base, "root");
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(root), auth);
  const staticPort = await freePort();
  const STATIC = `nats://127.0.0.1:${staticPort}`;
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await startBroker((s) => {
    const conf = join(s, "server.conf");
    writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: staticPort, storeDir: s, host: "127.0.0.1" }));
    return ["-c", conf];
  }, STATIC, provisionerCreds);
  await setupSpaceStreams({ servers: STATIC, space: SPACE, creds: provisionerCreds });
  await seedChannelRegistry({ servers: STATIC, space: SPACE, creds: provisionerCreds, file: { channels: { review: {} } } });
  recordMesh({ space: SPACE, server: STATIC, root, mode: "auth", ts: new Date().toISOString() });
  const provisioner = new CotalEndpoint({ space: SPACE, servers: STATIC, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {});
  await provisioner.start();
  endpoints.push(provisioner);
  const botIdentity = newIdentity();
  const botUid = mintLifecycleUid();
  const botCreds = await provisionAgent(provisioner, auth, botIdentity, { lifecycleUid: botUid, subscribe: ["review"], allowSubscribe: ["review"] });
  const staticGot: CotalMessage[] = [];
  const replies: number[] = [];
  const staticBot = new CotalEndpoint({
    space: SPACE, servers: STATIC, creds: botCreds, lifecycleUid: botUid,
    card: { name: "bot", kind: "agent", id: botIdentity.id }, channels: ["review"], heartbeatMs: 500, ttlMs: 5000,
  });
  staticBot.on("error", () => {});
  staticBot.on("message", (m: CotalMessage, d?: { ack?: () => void }) => {
    staticGot.push(m);
    d?.ack?.();
    // The agent answers every DM, the way the spike's agent did.
    if (m.to) void staticBot.unicastAttributed(m.from.id, `re: ${textOf(m)}`).then((r) => replies.push(r.ack.seq), () => replies.push(-1));
  });
  await staticBot.start();
  endpoints.push(staticBot);

  const staticWeb = await startWeb(["--space", SPACE]);
  const startMeta = (await getJson(staticWeb, "/api/meta")) as Record<string, unknown> | undefined;
  ok("3.0 the shipped `web` entry point serves on the static mesh, with an operatorId from startup",
    typeof startMeta?.operatorId === "string", { startMeta, log: staticWeb.log().slice(-400) });
  const staticBotShows = await until(async () => (((await getJson(staticWeb, "/api/roster")) ?? []) as Row[]).some((r) => r.card.id === staticBot.card.id && r.status !== "offline") || undefined);
  const sMsg = await send(staticWeb, { kind: "msg", channel: "review", text: "static hello" });
  const dm1 = await send(staticWeb, { kind: "dm", to: staticBot.card.id, text: "first dm" });
  const dm2 = await send(staticWeb, { kind: "dm", to: staticBot.card.id, text: "second dm" });
  const three = await until(() => {
    const mine = staticGot.filter((m) => ["static hello", "first dm", "second dm"].includes(textOf(m)));
    return mine.length === 3 ? mine : undefined;
  });
  ok("3.1 a channel post and two DMs reach the test endpoint from one operator, the id /api/meta reported at startup",
    staticBotShows === true && [sMsg, dm1, dm2].every((r) => r.status === 200 && r.json?.operatorId === startMeta?.operatorId)
    && three !== undefined && three.every((m) => m.from.id === startMeta?.operatorId && m.from.name === "operator"),
    { staticBotShows, sMsg: sMsg.text, dm1: dm1.text, dm2: dm2.text, from: three?.map((m) => m.from.id) ?? staticGot.map((m) => [textOf(m), m.from.id]) });
  ok("3.2 a DM answers with the sequence the broker stored it at, and a channel post with none",
    typeof dm1.json?.seq === "number" && typeof dm2.json?.seq === "number" && (dm2.json.seq as number) > (dm1.json.seq as number) && !("seq" in (sMsg.json ?? {})),
    { dm1: dm1.json, dm2: dm2.json, msg: sMsg.json });
  type Dm = { from: { id: string }; to?: string; parts: Array<{ kind: string; text?: string }> };
  const dms = await until(async () => {
    const page = ((await getJson(staticWeb, "/api/dms")) ?? []) as Dm[];
    const texts = page.map((m) => m.parts.map((p) => p.text ?? "").join(""));
    return ["first dm", "second dm", "re: first dm", "re: second dm"].every((t) => texts.includes(t)) ? page : undefined;
  });
  // Grouped by the client's own `dmPeers`, so the cell holds for the conversation the DM view shows.
  const operatorPeer = dmPeers((dms ?? []).map((msg) => ({ msg: msg as unknown as CotalMessage })), [])
    .find((p) => p.id === startMeta?.operatorId);
  ok("3.3 the agent's replies land in /api/dms under the one conversation key both DMs share",
    dms !== undefined && operatorPeer?.conversations.length === 1 && operatorPeer.conversations[0].with === staticBot.card.id
    && operatorPeer.conversations[0].messages.length === dms.length,
    { conversations: operatorPeer?.conversations.map((c) => ({ with: c.with, messages: c.messages.length })), dms: dms?.length, replies });
  await stopWeb(staticWeb);

  const credsFile = join(base, "admin.creds");
  writeFileSync(credsFile, await mintCreds(auth, newIdentity(), "admin"), { mode: 0o600 });
  const credsWeb = await startWeb(["--creds", credsFile, "--server", STATIC, "--space", SPACE]);
  const credsPost = await send(credsWeb, { kind: "msg", channel: "review", text: "from a read-only dashboard" });
  ok("3.4 a --creds dashboard refuses a post with 403 and POST_OFF_CREDS",
    credsPost.status === 403 && credsPost.json?.error === POST_OFF_CREDS, { credsPost: credsPost.text, log: credsWeb.log().slice(-300) });
  await stopWeb(credsWeb);

  // ---- 4. the refusals every mesh gives ----------------------------------------------------------
  console.log("4. the refusals every mesh gives");
  const wild = await send(openWeb, { kind: "msg", channel: "review.*", text: "to everyone" });
  ok("4.1 a wildcard channel is refused with 400, naming it as more than one channel",
    wild.status === 400 && wild.json?.error === '"review.*" is not one channel', wild.text);
  const alias = await send(openWeb, { kind: "msg", channel: `abc${RLO}`, text: "aliased" });
  ok("4.2 a channel name the wire would rewrite is refused with 400, naming it escaped",
    alias.status === 400 && alias.text.includes("is not a channel") && alias.text.includes("\\\\u202e") && !alias.text.includes(RLO), alias.text);
  const unknown = await send(openWeb, { kind: "dm", to: `ghost${RLO}`, text: "anyone there" });
  ok("4.3 an unknown `to` is refused with 400, naming it escaped",
    unknown.status === 400 && unknown.json?.error === 'no agent with id "ghost\\u202e" is on the roster' && !unknown.text.includes(RLO), unknown.text);
  const empty = await send(openWeb, { kind: "msg", channel: "review", text: "   " });
  ok("4.4 an empty text is refused with 400", empty.status === 400 && empty.json?.error === "text required", empty.text);
  const badKind = await send(openWeb, { kind: "ask", channel: "review", text: "hi" });
  ok("4.5 a kind other than msg or dm is refused with 400", badKind.status === 400 && badKind.json?.error === 'kind must be "msg" or "dm"', badKind.text);
  const notJson = await call(openWeb, "POST", "/api/send", { body: "{not json" });
  ok("4.6 a body that is not a JSON object is refused with 400", notJson.status === 400 && notJson.json?.error === "the request body must be a JSON object", notJson.text);
  // Announced and never sent, the way body-cap.smoke.ts 7.1 reads the reply: a body left unread
  // under a close goes out as an RST, which can drop the reply the caller had buffered.
  const big = await call(openWeb, "POST", "/api/send", { headers: { "content-type": "application/json", "content-length": String(9 * 1024), connection: "keep-alive" } });
  ok("4.7 a 9 KiB body is refused with 413 and the connection is closed",
    big.status === 413 && big.headers.connection === "close", { status: big.status, connection: big.headers.connection, text: big.text.slice(0, 160) });
  const cross = await call(openWeb, "POST", "/api/send", { body: JSON.stringify({ kind: "msg", channel: "review", text: "x" }), headers: { origin: "http://evil.example" } });
  ok("4.8 a cross-origin post is refused with 403 cross-origin", cross.status === 403 && cross.json?.error === "cross-origin", cross.text);
  const anon = await call(openWeb, "POST", "/api/send", { body: JSON.stringify({ kind: "msg", channel: "review", text: "x" }), cookie: false });
  ok("4.9 a post with no session cookie is refused with 401", anon.status === 401 && anon.json?.error === "unauthenticated", anon.text);
  ok("4.10 CONTROL: none of the refused channel posts reached the subscriber",
    !openGot.some((m) => ["to everyone", "aliased", "   ", "x", REFUSE].includes(textOf(m))), openGot.map(textOf));
  await stopWeb(openWeb);
} finally {
  for (const e of endpoints) await e.stop().catch(() => undefined);
  for (const k of kids) k.kill("SIGKILL");
  for (const r of releases) r();
  for (const s of stores) rmSync(s, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
}

console.log(`web send: ${failed === 0 ? `${cells} cells OK` : `${failed} of ${cells} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
