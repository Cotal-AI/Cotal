/**
 * Remote gateway surface (registerCotalGatewayTools), driven end to end: its OWN nats-server, the
 * package's own HTTP handler (handleGatewayRequest) behind bearer auth, and the real SDK client. Every call shares one
 * bearer per account, as a hosted MCP client does across conversations, so only the explicit
 * connection_id can tell two conversations apart.
 *
 * Proves:
 *   - an authoritative collision moves to the next name, and nothing else does;
 *   - an invalid name is refused before any issue, and exhaustion tries every variant;
 *   - concurrent connects against an atomic issuer get distinct names;
 *   - a missing, unknown, or other account's handle runs nothing, with no default connection;
 *   - an unauthenticated call runs nothing on any tool;
 *   - each call runs on its connection's own channels, and the advertised send default names none;
 *   - two connections of one account are independent mesh identities;
 *   - disconnect closes one connection and leaves the other working;
 *   - only the remote subset is offered, and the orientation card says so;
 *   - cotal_wait returns a message as soon as it arrives, at once when one is waiting, and after its
 *     bound with none; it follows attention, counts a focus @mention that landed between waits,
 *     ignores a run turn the gateway cannot surface, ends when its connection closes, and leaves
 *     no listener behind; a wait or read whose client is gone clears nothing; every other tool
 *     says when messages are waiting;
 *   - the handler answers POST with JSON and the default instructions, and every other method 405.
 *
 * Run: pnpm smoke:gateway
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid, type CotalMessage, type Delivery } from "@cotal-ai/core";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GATEWAY_INSTRUCTIONS, NameTaken, handleGatewayRequest, registerCotalGatewayTools, type GatewayConnection, type GatewayHost } from "../src/gateway.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "gatewaysmoke";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
// The bound this embedder sets for cotal_wait, short enough for a suite and long enough for a DM.
const WAIT = 20;

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// A connection named inc... reads #incidents, the others #lobby, so a call that ran on the wrong
// configuration would land on the wrong channel.
const configFor = (name: string): AgentConfig => {
  const channel = name.startsWith("inc") ? "incidents" : "lobby";
  return {
  space,
  name,
  servers,
  subscribe: [channel],
  allowSubscribe: [channel],
  allowPublish: [channel],
  kind: "agent",
  tls: false,
  id: `${name}_${randomUUID().slice(0, 8)}`,
  lifecycleUid: mintLifecycleUid(),
  };
};

// The issuer this host stands in for: names are unique per account and reserved atomically before
// the slow start, "quota_probe" fails the way a quota refusal does, every "full" variant is taken,
// and every attempt is logged so a retry under another name is visible.
const BEARERS: Record<string, string> = { "tok-a": "acct_a", "tok-b": "acct_b" };
const live = new Map<string, { account: string; conn: GatewayConnection }>();
const opened: string[] = [];
const reserved = new Set<string>();
const host: GatewayHost = {
  account(auth: AuthInfo | undefined): string {
    const account = auth?.extra?.account;
    if (typeof account !== "string") throw new Error("no valid bearer");
    return account;
  },
  async open(account, name) {
    opened.push(`${account}/${name}`);
    if (name === "quota_probe") throw new Error("quota exceeded");
    if (name === "full" || name.startsWith("full_")) throw new NameTaken(name);
    const key = `${account}/${name}`;
    if (reserved.has(key)) throw new NameTaken(name);
    reserved.add(key);
    const config = configFor(name);
    const agent = new MeshAgent(config);
    agent.on("error", () => {});
    agent.start();
    for (let i = 0; i < 50 && !agent.connected; i++) await sleep(100);
    if (!agent.connected) {
      reserved.delete(key);
      throw new Error(`${name} did not connect`);
    }
    const conn = { id: randomUUID(), agent, config };
    live.set(conn.id, { account, conn });
    return conn;
  },
  async find(account, id) {
    const r = live.get(id);
    return r && r.account === account ? r.conn : undefined;
  },
  async close(account, id) {
    const r = live.get(id);
    if (!r || r.account !== account) return false;
    live.delete(id);
    reserved.delete(`${account}/${r.conn.config.name}`);
    await r.conn.agent.stop();
    return true;
  },
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined));
    req.on("error", reject);
  });

// The embedder's part: the bearer decides the account and nothing else. The body is parsed first,
// as a web framework would, and the handler serves the rest.
const http = createServer(async (req, res) => {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const account = token ? BEARERS[token] : undefined;
  const auth: AuthInfo | undefined = account ? { token: token!, clientId: "smoke", scopes: [], extra: { account } } : undefined;
  await handleGatewayRequest(host, { req, res, body: req.method === "POST" ? await readBody(req) : undefined, waitSeconds: WAIT, ...(auth ? { auth } : {}) });
});
const httpPort = await new Promise<number>((resolve) => http.listen(0, "127.0.0.1", () => resolve((http.address() as { port: number }).port)));
const url = new URL(`http://127.0.0.1:${httpPort}/mcp`);

const clients: Client[] = [];
const clientFor = async (token?: string): Promise<Client> => {
  const client = new Client({ name: "gateway-smoke-client", version: "0.0.0" });
  clients.push(client);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
};
type CallResult = { text: string; isError: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<CallResult> => {
  const r = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  return { text: (r.content ?? []).map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
};
const idOf = (r: CallResult): string => /connection_id: (\S+)/.exec(r.text)?.[1] ?? "";

const observer = new CotalEndpoint({ space, servers, card: { name: "observer", kind: "agent", id: "observer" }, channels: ["lobby", "incidents"], lifecycleUid: mintLifecycleUid() });
observer.on("error", () => {});
const heard: string[] = [];
const heardOn = new Map<string, string>();
observer.on("message", (m: CotalMessage, d: Delivery) => {
  const text = m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
  heard.push(text);
  if (m.channel) heardOn.set(text, m.channel);
  d.ack();
});

let failure: unknown;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await observer.start();

  const a = await clientFor("tok-a");
  const b = await clientFor("tok-b");
  const anon = await clientFor();

  // ---- the handler ----
  check("the handler sends the default instructions", a.getInstructions() === GATEWAY_INSTRUCTIONS, a.getInstructions());
  for (const method of ["GET", "DELETE"]) {
    const r = await fetch(url, { method, headers: { authorization: "Bearer tok-a", accept: "text/event-stream, application/json" } });
    const allow = r.headers.get("allow");
    await r.body?.cancel();
    check(`${method} answers 405 with no stream to open`, r.status === 405 && allow === "POST", { status: r.status, allow });
  }
  const ping = await fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer tok-a", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const pingType = ping.headers.get("content-type") ?? "";
  const pingBody = (await ping.json().catch(() => null)) as { result?: { tools?: unknown[] } } | null;
  check("a POST is answered as one JSON response", ping.status === 200 && pingType.startsWith("application/json") && Array.isArray(pingBody?.result?.tools), { status: ping.status, pingType });

  // ---- the offered surface ----
  const tools = (await a.listTools()).tools;
  const names = new Set(tools.map((t) => t.name));
  check("connect and disconnect are offered", names.has("cotal_connect") && names.has("cotal_disconnect"));
  check("seat authority is not offered", !["cotal_spawn", "cotal_despawn", "cotal_persona", "cotal_run", "cotal_reconnect", "cotal_yield"].some((n) => names.has(n)));
  const routed = tools.filter((t) => t.name !== "cotal_connect");
  check(
    "every routed tool requires connection_id",
    routed.length === 15 && routed.every((t) => (t.inputSchema.required ?? []).includes("connection_id")),
    routed.map((t) => t.name),
  );

  // ---- authentication ----
  const unauth = await call(anon, "cotal_connect", { name: "ghost" });
  check("an unauthenticated connect is refused", unauth.isError && unauth.text.includes("not authenticated"), unauth);
  check("an unauthenticated connect opens nothing", !opened.some((o) => o.endsWith("/ghost")), opened);

  // ---- name allocation ----
  const first = await call(a, "cotal_connect", { name: "claude" });
  const id1 = idOf(first);
  check("the requested name is used when free", !first.isError && first.text.startsWith("Connected as claude.") && id1 !== "", first);
  const second = await call(a, "cotal_connect", { name: "claude" });
  const id2 = idOf(second);
  check("a taken name moves to the next one and says so", !second.isError && second.text.startsWith('Connected as claude_2 ("claude" was taken).'), second);
  check("the two conversations hold different connections", id2 !== "" && id2 !== id1);
  check("the collision was retried only on NameTaken", opened.filter((o) => o.startsWith("acct_a/")).join(",") === "acct_a/claude,acct_a/claude,acct_a/claude_2", opened);
  const quota = await call(a, "cotal_connect", { name: "quota_probe" });
  check("a non-collision failure is reported", quota.isError && quota.text.includes("quota exceeded"), quota);
  check("a non-collision failure is not retried under another name", !opened.includes("acct_a/quota_probe_2") && opened.filter((o) => o === "acct_a/quota_probe").length === 1, opened);
  const other = await call(b, "cotal_connect", { name: "claude" });
  check("another account's names are its own", !other.isError && other.text.startsWith("Connected as claude."), other);
  const idB = idOf(other);

  const invalid = await call(a, "cotal_connect", { name: "claude/admin" });
  check("an invalid name is refused before any open", invalid.isError && invalid.text.includes("invalid name") && !opened.some((o) => o.includes("claude/admin")), { invalid, opened });
  const full = await call(a, "cotal_connect", { name: "full" });
  const fullTries = opened.filter((o) => o === "acct_a/full" || o.startsWith("acct_a/full_"));
  check(
    "an exhausted name tries every variant and says so",
    full.isError && full.text.includes("are all taken") && fullTries.length === 20 && fullTries[19] === "acct_a/full_20",
    { full, fullTries },
  );
  const burst = await Promise.all(Array.from({ length: 4 }, () => call(a, "cotal_connect", { name: "burst" })));
  const burstNames = burst.map((r) => /^Connected as (\S+?)[. ]/.exec(r.text)?.[1] ?? "").sort();
  check("concurrent connects get distinct names", burstNames.join(",") === "burst,burst_2,burst_3,burst_4", burst);

  // ---- no fallback ----
  const missing = await a.callTool({ name: "cotal_roster", arguments: {} }).then(
    (r) => ({ isError: (r as { isError?: boolean }).isError === true, text: JSON.stringify(r) }),
    (e: unknown) => ({ isError: true, text: String(e) }),
  );
  check("a call without connection_id is refused", missing.isError && missing.text.includes("connection_id"), missing);
  const anonSend = await call(anon, "cotal_send", { connection_id: id1, text: "from-anon", channel: "lobby" });
  check("an unauthenticated routed call is refused", anonSend.isError && anonSend.text.startsWith("not authenticated"), anonSend);
  const anonBye = await call(anon, "cotal_disconnect", { connection_id: id1 });
  check("an unauthenticated disconnect is refused", anonBye.isError && anonBye.text.startsWith("not authenticated"), anonBye);
  const unknown = await call(a, "cotal_send", { connection_id: "not-a-connection", text: "from-unknown", channel: "lobby" });
  check("an unknown connection_id is refused", unknown.isError && unknown.text.startsWith("CONNECTION_REQUIRED"), unknown);
  const foreign = await call(b, "cotal_send", { connection_id: id1, text: "from-foreign", channel: "lobby" });
  check("another account's connection_id is refused", foreign.isError && foreign.text.startsWith("CONNECTION_REQUIRED"), foreign);
  const extraKey = await call(a, "cotal_roster", { connection_id: id1, owner: "someone" }).catch((e: unknown) => ({ isError: true, text: String(e) }));
  check("an unmodelled argument is still refused", extraKey.isError, extraKey);

  // ---- independent identities ----
  const sent = await call(a, "cotal_send", { connection_id: id1, text: "hello-from-claude", channel: "lobby" });
  check("a connection sends under its own identity", !sent.isError, sent);
  for (let i = 0; i < 30 && !heard.includes("hello-from-claude"); i++) await sleep(100);
  check("the send reached the mesh", heard.includes("hello-from-claude"), heard);
  check("refused sends reached nothing", !heard.includes("from-unknown") && !heard.includes("from-foreign") && !heard.includes("from-anon"), heard);

  const sendTool = tools.find((t) => t.name === "cotal_send");
  const channelText = JSON.stringify((sendTool?.inputSchema.properties as Record<string, unknown> | undefined)?.channel ?? "");
  check("the advertised send default names no connection's channel", channelText.includes("this connection's default") && !channelText.includes("lobby"), channelText);
  const inc = await call(a, "cotal_connect", { name: "inc_watch" });
  const incSent = await call(a, "cotal_send", { connection_id: idOf(inc), text: "default-channel-probe" });
  for (let i = 0; i < 30 && !heardOn.has("default-channel-probe"); i++) await sleep(100);
  check("an omitted channel uses that connection's own default", !incSent.isError && heardOn.get("default-channel-probe") === "incidents", { incSent, channel: heardOn.get("default-channel-probe") });

  for (let i = 0; i < 30; i++) {
    const roster = await call(a, "cotal_roster", { connection_id: id1 });
    if (roster.text.includes("claude_2")) break;
    await sleep(200);
  }
  const dm = await call(a, "cotal_dm", { connection_id: id1, to: "claude_2", text: "dm-for-the-second" });
  check("one connection can message another by name", !dm.isError, dm);
  let inbox2: CallResult = { text: "", isError: true };
  for (let i = 0; i < 30; i++) {
    inbox2 = await call(a, "cotal_inbox", { connection_id: id2, peek: true });
    if (inbox2.text.includes("dm-for-the-second")) break;
    await sleep(100);
  }
  check("the second connection received it", inbox2.text.includes("dm-for-the-second") && inbox2.text.includes("claude"), inbox2);
  const inbox1 = await call(a, "cotal_inbox", { connection_id: id1, peek: true });
  check("the sender's own inbox did not receive it", !inbox1.text.includes("dm-for-the-second"), inbox1);

  const card = await call(a, "cotal_orientation", { connection_id: id2 });
  check("orientation names this connection", card.text.includes("claude_2"), card.text.slice(0, 400));
  check("orientation lists only offered tools", card.text.includes("cotal_inbox") && !card.text.includes("cotal_spawn") && !card.text.includes("cotal_reconnect"), card.text);

  // ---- listening ----
  const listener = idOf(await call(a, "cotal_connect", { name: "listener" }));
  const talker = idOf(await call(a, "cotal_connect", { name: "talker" }));
  const listenerAgent = live.get(listener)!.conn.agent;
  for (let i = 0; i < 30; i++) {
    if ((await call(a, "cotal_roster", { connection_id: talker })).text.includes("listener")) break;
    await sleep(200);
  }
  const waitTool = tools.find((t) => t.name === "cotal_wait");
  const waitMax = ((waitTool?.inputSchema.properties as Record<string, { maximum?: number }> | undefined)?.seconds ?? {}).maximum;
  check(
    "cotal_wait is offered, needs connection_id and is bounded by the embedder",
    !!waitTool && (waitTool.inputSchema.required ?? []).includes("connection_id") && waitMax === WAIT,
    waitTool,
  );
  const tooLong = await call(a, "cotal_wait", { connection_id: listener, seconds: WAIT + 1 }).catch((e: unknown) => ({ isError: true, text: String(e) }));
  check("a wait past the bound is refused", tooLong.isError, tooLong);
  const unknownWait = await call(a, "cotal_wait", { connection_id: "not-a-connection" });
  check("a wait on an unknown connection_id is refused", unknownWait.isError && unknownWait.text.startsWith("CONNECTION_REQUIRED"), unknownWait);
  const anonWait = await call(anon, "cotal_wait", { connection_id: listener });
  check("an unauthenticated wait is refused", anonWait.isError && anonWait.text.startsWith("not authenticated"), anonWait);
  let threw = "";
  try {
    registerCotalGatewayTools(new McpServer({ name: "x", version: "0" }), host, "gateway", { waitSeconds: 0 });
  } catch (e) {
    threw = String(e);
  }
  check("an embedder's bound below one second is refused", threw.includes("waitSeconds"), threw);

  let started = Date.now();
  const quiet = await call(a, "cotal_wait", { connection_id: listener, seconds: 1 });
  const quietMs = Date.now() - started;
  check("a wait with nothing to read returns after its bound", !quiet.isError && quiet.text.startsWith("No new messages in 1 second.") && quietMs >= 900 && quietMs < 4000, { quiet, quietMs });
  // Taken after the first wait, which starts the gateway's one lasting focus @mention listener.
  const baseListeners = ["incoming", "mention-wake", "transport"].map((e) => listenerAgent.listenerCount(e)).join(",");

  const listening = call(a, "cotal_wait", { connection_id: listener });
  await sleep(500);
  started = Date.now();
  await call(a, "cotal_dm", { connection_id: talker, to: "listener", text: "wake-up-listener" });
  const woke = await listening;
  const wokeMs = Date.now() - started;
  check("a direct message ends the wait and comes back with it", !woke.isError && woke.text.includes("wake-up-listener") && wokeMs < 5000, { woke, wokeMs });
  const cleared = await call(a, "cotal_inbox", { connection_id: listener, peek: true });
  check("the message the wait returned was cleared", cleared.text.startsWith("Inbox empty"), cleared);

  const peekFor = async (text: string): Promise<boolean> => {
    for (let i = 0; i < 30; i++) {
      if ((await call(a, "cotal_inbox", { connection_id: listener, peek: true })).text.includes(text)) return true;
      await sleep(100);
    }
    return false;
  };
  await call(a, "cotal_dm", { connection_id: talker, to: "listener", text: "already-waiting" });
  const arrived = await peekFor("already-waiting");
  started = Date.now();
  const ready = await call(a, "cotal_wait", { connection_id: listener });
  check("a message already waiting is returned at once", arrived && ready.text.includes("already-waiting") && Date.now() - started < 2000, ready);

  await call(a, "cotal_dm", { connection_id: talker, to: "listener", text: "notice-probe" });
  await peekFor("notice-probe");
  const noticed = await call(a, "cotal_roster", { connection_id: listener });
  check("another tool's result says a message is waiting", noticed.text.includes("1 new message waiting. Read it with cotal_inbox."), noticed);
  await call(a, "cotal_inbox", { connection_id: listener });
  const quietRoster = await call(a, "cotal_roster", { connection_id: listener });
  check("the notice is gone once the message is read", !quietRoster.text.includes("new message"), quietRoster);

  await call(a, "cotal_status", { connection_id: listener, attention: "dnd" });
  const dndWait = call(a, "cotal_wait", { connection_id: listener, seconds: 2 });
  await sleep(300);
  await call(a, "cotal_send", { connection_id: talker, text: "lobby-chatter", channel: "lobby" });
  const dndResult = await dndWait;
  check("in dnd attention, channel chatter does not end the wait", dndResult.text.startsWith("No new messages"), dndResult);
  await call(a, "cotal_status", { connection_id: listener, attention: "open" });
  const openResult = await call(a, "cotal_wait", { connection_id: listener, seconds: 2 });
  check("in open attention, the same chatter ends it", openResult.text.includes("lobby-chatter"), openResult);
  await call(a, "cotal_status", { connection_id: listener, attention: "focus" });
  const focusWait = call(a, "cotal_wait", { connection_id: listener, seconds: 5 });
  await sleep(300);
  started = Date.now();
  await call(a, "cotal_send", { connection_id: talker, text: "focus-mention", channel: "lobby", mentions: ["listener"] });
  const focusResult = await focusWait;
  check("in focus attention, an @mention ends the wait and comes back with it", focusResult.text.includes("focus-mention") && Date.now() - started < 4000, focusResult);
  await call(a, "cotal_status", { connection_id: listener, attention: "open" });

  // A client that gives up on a wait closes its request, as Claude Code does at its 60 s timer.
  const dropping = new AbortController();
  const dropped = fetch(url, {
    method: "POST",
    signal: dropping.signal,
    headers: { authorization: "Bearer tok-a", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "cotal_wait", arguments: { connection_id: listener } } }),
  }).catch(() => undefined);
  await sleep(500);
  dropping.abort();
  await dropped;
  await sleep(300);
  await call(a, "cotal_dm", { connection_id: talker, to: "listener", text: "after-a-dropped-wait" });
  check("a wait its client dropped does not take the next message", await peekFor("after-a-dropped-wait"));
  await call(a, "cotal_inbox", { connection_id: listener });

  // A client that gives up after a message woke the wait, while the read is still under way. In
  // focus the read first fetches channel history, so the abort is made to land during that fetch.
  await call(a, "cotal_status", { connection_id: listener, attention: "focus" });
  const midRead = new AbortController();
  const recall = listenerAgent.recallAmbient.bind(listenerAgent);
  listenerAgent.recallAmbient = async (...args: Parameters<typeof recall>) => {
    midRead.abort();
    await sleep(300);
    return recall(...args);
  };
  const abandoned = fetch(url, {
    method: "POST",
    signal: midRead.signal,
    headers: { authorization: "Bearer tok-a", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 78, method: "tools/call", params: { name: "cotal_wait", arguments: { connection_id: listener } } }),
  }).catch(() => undefined);
  await sleep(500);
  await call(a, "cotal_dm", { connection_id: talker, to: "listener", text: "woke-a-dropped-read" });
  await abandoned;
  await sleep(800);
  Reflect.deleteProperty(listenerAgent, "recallAmbient");
  check("a read its client dropped clears nothing it could not hand over", await peekFor("woke-a-dropped-read"));
  await call(a, "cotal_status", { connection_id: listener, attention: "open" });
  await call(a, "cotal_inbox", { connection_id: listener });

  // A client that leaves before the wait begins, while the host is still looking the connection up.
  const early = new AbortController();
  const find = host.find;
  host.find = async (...args) => {
    early.abort();
    await sleep(300);
    return find(...args);
  };
  await fetch(url, {
    method: "POST",
    signal: early.signal,
    headers: { authorization: "Bearer tok-a", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 79, method: "tools/call", params: { name: "cotal_wait", arguments: { connection_id: listener } } }),
  }).catch(() => undefined);
  await sleep(600);
  host.find = find;
  check("a wait whose client left before it began does not start", listenerAgent.listenerCount("incoming") === Number(baseListeners.split(",")[0]));
  await call(a, "cotal_dm", { connection_id: talker, to: "listener", text: "after-an-early-drop" });
  check("a wait whose client left before it began does not take the next message", await peekFor("after-an-early-drop"));
  await call(a, "cotal_inbox", { connection_id: listener });

  // A focus @mention is acked at ingest, so one that lands between two waits is counted by the gateway.
  await call(a, "cotal_status", { connection_id: listener, attention: "focus" });
  await call(a, "cotal_send", { connection_id: talker, text: "mention-between-waits", channel: "lobby", mentions: ["listener"] });
  let between: CallResult = { isError: false, text: "" };
  for (let i = 0; i < 30 && !between.text.includes("1 new message waiting"); i++) {
    await sleep(100);
    between = await call(a, "cotal_roster", { connection_id: listener });
  }
  check("a focus @mention between waits shows in the unread line", between.text.includes("1 new message waiting"), between);
  const caughtAt = Date.now();
  const caught = await call(a, "cotal_wait", { connection_id: listener, seconds: 5 });
  check("a focus @mention between waits ends the next wait at once", caught.text.includes("mention-between-waits") && Date.now() - caughtAt < 2000, caught);
  const afterRead = await call(a, "cotal_wait", { connection_id: listener, seconds: 1 });
  check("a read clears the focus @mentions it carried", afterRead.text.startsWith("No new messages"), afterRead);
  await call(a, "cotal_status", { connection_id: listener, attention: "open" });

  // Closing a connection ends a wait held on it.
  const closer = idOf(await call(a, "cotal_connect", { name: "closer" }));
  const closing = call(a, "cotal_wait", { connection_id: closer });
  await sleep(500);
  const closedAt = Date.now();
  await call(a, "cotal_disconnect", { connection_id: closer });
  const closed = await closing;
  check(
    "disconnecting ends a held wait as a closed connection",
    closed.isError && closed.text.startsWith("CONNECTION_REQUIRED") && Date.now() - closedAt < 3000,
    closed,
  );

  // A run turn the gateway has no way to surface. Set by hand: a gateway connection cannot take one
  // through any tool it offers, so this is the only way to hold one open here.
  const turns = (listenerAgent as unknown as { activeTurns: Map<string, unknown> }).activeTurns;
  turns.set("smoke-turn", { goalId: "smoke-turn", payload: {}, acceptedAt: Date.now(), deadlineAt: Date.now() + 60_000, surfaced: false });
  const turnWait = await call(a, "cotal_wait", { connection_id: listener, seconds: 1 });
  check(
    "a run turn the gateway cannot surface does not end the wait",
    listenerAgent.pendingWake() > 0 && turnWait.text.startsWith("No new messages"),
    turnWait,
  );
  turns.delete("smoke-turn");
  check(
    "a finished wait leaves no listener on the agent",
    ["incoming", "mention-wake", "transport"].map((e) => listenerAgent.listenerCount(e)).join(",") === baseListeners,
    baseListeners,
  );

  // ---- disconnect ----
  const wrongOwner = await call(b, "cotal_disconnect", { connection_id: id2 });
  check("another account cannot disconnect a connection", wrongOwner.isError && wrongOwner.text.startsWith("CONNECTION_REQUIRED"), wrongOwner);
  const bye = await call(a, "cotal_disconnect", { connection_id: id1 });
  check("disconnect closes that connection", !bye.isError && bye.text.includes(id1), bye);
  const after = await call(a, "cotal_roster", { connection_id: id1 });
  check("a closed connection_id is refused afterwards", after.isError && after.text.startsWith("CONNECTION_REQUIRED"), after);
  const still = await call(a, "cotal_connection_status", { connection_id: id2 });
  check("the other conversation's connection keeps working", !still.isError && still.text.includes("ready"), still);
  const stillB = await call(b, "cotal_connection_status", { connection_id: idB });
  check("the other account's connection keeps working", !stillB.isError && stillB.text.includes("ready"), stillB);

  console.log(`\nGATEWAY TESTS PASSED ✅  (${pass} checks)`);
} catch (e) {
  failure = e;
} finally {
  // A failed cell must still exit promptly: open client connections would otherwise hold the HTTP
  // server open and the suite would hang instead of going red.
  await Promise.allSettled(clients.map((c) => c.close()));
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  for (const { conn } of live.values()) await conn.agent.stop().catch(() => {});
  await observer.stop().catch(() => {});
  await killAndAwaitExit(srv);
  releaseBroker();
}
if (failure !== undefined) {
  console.error(failure);
  process.exit(1);
}
process.exit(0);
