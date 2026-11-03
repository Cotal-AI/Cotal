/**
 * `cotal history limit` against real brokers: the refusals before any connection, the provisioner
 * minted from the space root, the read-only call with no limit flag, the four streams one call sets,
 * the prompt a lower limit asks with its read-time snapshot per sender, agent and DM pair, a stream
 * that moved while the prompt waited, a change that stops partway, an update whose outcome the
 * command cannot know, and the receipts.
 *
 * The unknown cells run through a TCP hop that passes one JetStream request to the broker and then
 * cuts the command off before the reply, so the broker applies a change the command never hears of.
 *
 * Run: pnpm smoke:history-limit   (needs nats-server on PATH; builds the binary first)
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as tcpConnect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  CHAT_HISTORY_DEFAULT,
  CotalEndpoint,
  DEV_OWNER,
  INBOX_HISTORY_DEFAULT,
  chatStream,
  createSpaceAuth,
  dinboxSubject,
  dlvDurableConfig,
  dlvStream,
  dlvSubject,
  historyLimitStreamName,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setHistoryLimit,
  setupSpaceStreams,
  standaloneConnectOpts,
  type HistoryLimit,
  type HistoryLimitStream,
} from "@cotal-ai/core";
import { createSuite, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { clean, nodePty } from "./_console-pty.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 3_600_000, DAY = 86_400_000, NONE = -1;
type View = { maxAgeMs: number | null; perSubject: number | null };
type StreamRow = { stream: string; limit: HistoryLimitStream; from?: View; to?: View; holds?: View; outcome?: string };
type Lowered = { stream: string; overCount: { subject: string; dropped: number; undelivered?: number | null }[]; olderThan: string | null; oldestAt: string | null };
type Envelope = {
  outcome: string;
  result: { kind: string; changed?: boolean; confirmed?: boolean; streams: StreamRow[]; lowered?: Lowered[] } | null;
  error?: { code: string; message: string; remedy?: string };
  changed?: string[];
};
/** A limit as the JSON result shows it: null for no age or no count. */
const viewOf = (limit: HistoryLimit): View => ({ maxAgeMs: limit.maxAgeMs === 0 ? null : limit.maxAgeMs, perSubject: limit.perSubject === NONE ? null : limit.perSubject });
const sameView = (a: View | undefined, b: HistoryLimit) => a !== undefined && a.maxAgeMs === viewOf(b).maxAgeMs && a.perSubject === viewOf(b).perSubject;
const rowOf = (envelope: Envelope | undefined, stream: HistoryLimitStream) => envelope?.result?.streams.find((row) => row.limit === stream);

const space = `histlimit-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(storeDir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(storeDir, "js") }));
const broker = spawn("nats-server", ["-c", join(storeDir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, storeDir);
const openPort = await pickFreePort();
const openServers = `nats://127.0.0.1:${openPort}`;
const openStore = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const openBroker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(openPort), "-sd", join(openStore, "js")], { stdio: "ignore" });
const releaseOpenBroker = teardownOnSignal(openBroker, openStore);
const tag = randomUUID().slice(0, 8);
// Open spaces: one on the default limits, one with no streams, one holding entries for the preview,
// and three behind the cutting hop. An auth space whose root holds no trust.
const noAgeSpace = `histnoage-${tag}`;
const bareSpace = `histbare-${tag}`;
const previewSpace = `histpreview-${tag}`;
const cutSpaces = { update: `histcutfirst-${tag}`, second: `histcutsecond-${tag}`, readback: `histcutread-${tag}`, parked: `histparked-${tag}`, drift: `histdrift-${tag}` };
const untrusted = `histnotrust-${tag}`;

/** The cutting hop: passes everything to the open broker until the chosen request, which it still
 *  passes on, then drops every reply and closes the command's connection. `park` holds the read back
 *  after the first update instead, and everything the command sends after it, until released. */
type Cut = { at: "update"; nth: number } | { at: "readback" } | { at: "park" };
let cut: Cut | undefined;
let unpark: (() => void) | undefined;
const hopPort = await pickFreePort();
const hop: Server = createServer((client) => {
  const upstream = tcpConnect(openPort, "127.0.0.1");
  let updates = 0, sawUpdate = false, cutOff = false;
  const parked: Buffer[] = [];
  client.on("data", (chunk) => {
    if (parked.length) { parked.push(chunk); return; }
    if (cut?.at === "park" && !unpark) {
      const text = chunk.toString("latin1");
      if (/\$JS\.API\.STREAM\.UPDATE\./.test(text)) sawUpdate = true;
      else if (sawUpdate && /\$JS\.API\.STREAM\.INFO\./.test(text)) {
        parked.push(chunk);
        unpark = () => { for (const b of parked.splice(0)) upstream.write(b); };
        return;
      }
    }
    upstream.write(chunk);
    if (!cut || cut.at === "park" || cutOff) return;
    const text = chunk.toString("latin1");
    const n = (text.match(/\$JS\.API\.STREAM\.UPDATE\./g) ?? []).length;
    if (cut.at === "update") { updates += n; cutOff = updates >= cut.nth; }
    else if (n) sawUpdate = true;
    else cutOff = sawUpdate && /\$JS\.API\.STREAM\.INFO\./.test(text);
    if (cutOff) setTimeout(() => { client.destroy(); upstream.destroy(); }, 500);
  });
  upstream.on("data", (chunk) => { if (!cutOff) client.write(chunk); });
  for (const [a, b] of [[client, upstream], [upstream, client]] as const) { a.on("error", () => b.destroy()); a.on("close", () => b.destroy()); }
});
await new Promise<void>((resolve) => hop.listen(hopPort, "127.0.0.1", resolve));
const hopServers = `nats://127.0.0.1:${hopPort}`;

const home = mkdtempSync(join(tmpdir(), "cotal-history-limit-home-"));
const releaseHome = teardownPathOnSignal(home);
mkdirSync(join(home, ".cotal"), { recursive: true });
const xdg = join(home, "xdg");
mkdirSync(xdg);
const roots = { auth: join(home, "auth-root"), open: join(home, "open-root"), untrusted: join(home, "untrusted-root") };
for (const root of Object.values(roots)) mkdirSync(join(root, ".cotal"), { recursive: true });

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_") || key === "FORCE_COLOR" || key === "NO_COLOR") delete cleanEnv[key];
const isolatedEnv: NodeJS.ProcessEnv = { ...cleanEnv, HOME: home, USERPROFILE: home, TMPDIR: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };

type RunResult = { status: number; stdout: string; stderr: string; envelope?: Envelope };
// The launch sits in `run` itself, outside the promise callback, so the mutation auditor can trace
// BIN to this call and see that the suite runs bin/dist/cotal.js.
const run = (args: string[], cwd = roots.auth): Promise<RunResult> => {
  let done!: (result: RunResult) => void;
  const result = new Promise<RunResult>((resolve) => { done = resolve; });
  execFile(process.execPath, [BIN, ...args], { cwd, env: isolatedEnv, timeout: 120_000 }, (err, stdout, stderr) => {
    const lines = stdout.split("\n").filter(Boolean);
    const envelope = lines.length === 1 && lines[0]!.startsWith("{") ? (JSON.parse(lines[0]!) as Envelope) : undefined;
    done({ status: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr, envelope });
  });
  return result;
};
const shown = (r: { status: number; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 1500), stderr: r.stderr.slice(0, 800) });

/** One `cotal history limit` under a real terminal, so it may prompt. */
function terminal(args: string[], cwd = roots.auth) {
  const pty = nodePty([BIN, "history", "limit", ...args], { cwd, env: isolatedEnv as Record<string, string>, cols: 200, rows: 60 });
  let out = "";
  let code: number | undefined;
  pty.onData((d) => (out += d));
  pty.onExit((e) => (code = e.exitCode));
  const until = async (pred: (text: string) => boolean, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (pred(clean(out))) return true; await wait(100); }
    return false;
  };
  return { write: (s: string) => pty.write(s), until, text: () => clean(out), exited: () => until(() => code !== undefined), code: () => code, kill: () => pty.kill() };
}
const PROMPT = "Change the history limits of";

const endpoints: CotalEndpoint[] = [];
let provisioner: CotalEndpoint | undefined;
try {
  for (const s of [servers, openServers]) {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) { ready = await isReachable(s); if (!ready) await wait(100); }
    check(`control: the owned broker at ${s} is ready`, ready, s);
  }
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds: provisionerCreds, tls: false }) });
  const jsm = await jetstreamManager(nc);
  const onc = await connect({ servers: openServers });
  const ojsm = await jetstreamManager(onc);
  for (const s of [noAgeSpace, previewSpace, ...Object.values(cutSpaces)]) await setupSpaceStreams({ servers: openServers, space: s });
  saveSpaceAuth(authDir(roots.auth), auth);
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = isolatedEnv.COTAL_HOME;
  try {
    const ts = new Date().toISOString();
    recordMesh({ space, server: servers, root: roots.auth, mode: "auth", origin: "manual", ts });
    recordMesh({ space: untrusted, server: servers, root: roots.untrusted, mode: "auth", origin: "manual", ts });
    for (const s of [noAgeSpace, bareSpace, previewSpace]) recordMesh({ space: s, server: openServers, root: roots.open, mode: "open", origin: "manual", ts });
    for (const s of Object.values(cutSpaces)) recordMesh({ space: s, server: hopServers, root: roots.open, mode: "open", origin: "manual", ts });
  } finally {
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
  }
  const limitOf = async (m: JetStreamManager, s: string, stream: HistoryLimitStream = "chat"): Promise<HistoryLimit> => {
    const { config } = await m.streams.info(historyLimitStreamName(s, stream));
    return { maxAgeMs: config.max_age / 1_000_000, perSubject: config.max_msgs_per_subject };
  };
  const same = (a: HistoryLimit | undefined, b: HistoryLimit) => a !== undefined && a.maxAgeMs === b.maxAgeMs && a.perSubject === b.perSubject;

  // ── refusals before any connection ──────────────────────────────────────────────────────────────
  for (const [args, what, needle] of [
    [["--max-age", "1m", "--yes"], "an age below 2m", "--max-age: the age must be at least 2m"],
    [["--max-age", "0s", "--yes"], "an age of 0s, which is not none", "--max-age: the age must be at least 2m"],
    [["--inbox-max-age", "0h", "--yes"], "an inbox age of 0h, which is not none", "--inbox-max-age: the age must be at least 2h"],
    [["--dm-max-age", "0d", "--yes"], "a DM age of 0d, which is not none", "--dm-max-age: the age must be at least 2m"],
    [["--max-age", "5x", "--yes"], "an age that is not one", "--max-age takes an age such as 30d, 12h or 90m, or none"],
    [["--per-sender", "0", "--yes"], "a count of 0", "--per-sender: the count must be a whole number of at least 1"],
    [["--max-age", "4000d", "--yes"], "an age past 3650d", "at most 3650d"],
    [["--inbox-max-age", "1h", "--yes"], "an inbox age below 2h", "--inbox-max-age: the age must be at least 2h"],
    [["--inbox-per-agent", "-3", "--yes"], "a negative inbox count", "--inbox-per-agent takes a whole number of at least 1, or none"],
    [["--dm-max-age", "90s", "--yes"], "a DM age below 2m", "--dm-max-age: the age must be at least 2m"],
    [["--dm-per-sender", "many", "--yes"], "a DM count that is not one", "--dm-per-sender takes a whole number"],
    [["general", "--max-age", "7d", "--yes"], "a channel", "takes no channel"],
    [["--max-age", "7d", "--server", servers, "--yes"], "--server", "takes only"],
  ] as const) {
    const r = await run(["history", "limit", ...args, "--json", "--space", "no-such-space"]);
    check(`history limit refuses ${what} as usage, before resolving any target`, r.status === 1 && r.envelope?.error?.code === "USAGE_INVALID" && r.envelope.error.message.includes(needle), shown(r));
  }
  const noYes = await run(["history", "limit", "--max-age", "7d", "--json", "--space", space]);
  check("--json without --yes is refused before any credential is minted", noYes.status === 1 && noYes.envelope?.error?.code === "USAGE_INVALID" && noYes.envelope.error.message.includes("requires --yes"), shown(noYes));
  check("...and changed nothing", same(await limitOf(jsm, space), CHAT_HISTORY_DEFAULT));
  const noTrust = await run(["history", "limit", "--max-age", "7d", "--yes", "--json", "--space", untrusted], roots.untrusted);
  check("a root without the space's trust is refused PERMISSION_DENIED", noTrust.status === 2 && noTrust.envelope?.error?.code === "PERMISSION_DENIED" && noTrust.envelope.error.message.includes("no trust material"), shown(noTrust));
  const bare = await run(["history", "limit", "--max-age", "7d", "--yes", "--json", "--space", bareSpace], roots.open);
  const bareCreated = await ojsm.streams.info(chatStream(bareSpace)).then(() => true, () => false);
  check("a space with no chat stream is refused TARGET_NOT_FOUND", bare.status === 2 && bare.envelope?.error?.code === "TARGET_NOT_FOUND" && bare.envelope.error.message.includes(`no ${chatStream(bareSpace)} stream`), shown(bare));
  check("...and no chat stream was created", bareCreated === false);

  // ── the read-only call ───────────────────────────────────────────────────────────────────────────
  const read = await run(["history", "limit", "--json", "--space", space]);
  const expected: Record<HistoryLimitStream, HistoryLimit> = { chat: CHAT_HISTORY_DEFAULT, inbox: INBOX_HISTORY_DEFAULT, dlv: INBOX_HISTORY_DEFAULT, dm: { maxAgeMs: 0, perSubject: NONE } };
  check("with no limit flag, --json without --yes reads the four streams' limits", read.status === 0 && read.envelope?.outcome === "ok" && read.envelope.result?.kind === "history-limits" && (["chat", "inbox", "dlv", "dm"] as const).every((s) => sameView(rowOf(read.envelope, s)?.holds, expected[s])), shown(read));
  const readPlain = await run(["history", "limit", "--plain", "--space", space]);
  check("...and the report names each with no age or no count in words", readPlain.status === 0 && readPlain.stdout.includes("Channel posts") && readPlain.stdout.includes("no age limit, 1000 per sender") && readPlain.stdout.includes("no age limit, 1000 per agent") && readPlain.stdout.includes("no age limit, no count limit"), shown(readPlain));
  // An observer on the open broker sees every STREAM.UPDATE request the command sends.
  const updates: string[] = [];
  const watch = onc.subscribe("$JS.API.STREAM.UPDATE.>", { callback: (_e, m) => { updates.push(m.subject); } });
  await onc.flush();
  const quietRead = await run(["history", "limit", "--json", "--space", noAgeSpace], roots.open);
  await onc.flush();
  await wait(300);
  check("the read-only call publishes no STREAM.UPDATE", quietRead.status === 0 && updates.length === 0, { updates, run: shown(quietRead) });

  // ── a part alone, and none ───────────────────────────────────────────────────────────────────────
  const countOnly = await run(["history", "limit", "--per-sender", "500", "--yes", "--json", "--space", noAgeSpace], roots.open);
  await wait(300);
  check("a count alone on a stream with no age limit keeps no age", countOnly.status === 0 && countOnly.envelope?.result?.changed === true && same(await limitOf(ojsm, noAgeSpace), { maxAgeMs: 0, perSubject: 500 }), shown(countOnly));
  check("...and the observer saw its one update, so the read-only cell watched a live path", updates.length === 1 && updates[0] === `$JS.API.STREAM.UPDATE.${chatStream(noAgeSpace)}`, updates);
  watch.unsubscribe();
  const allNone = await run(["history", "limit", "--max-age", "none", "--per-sender", "none", "--inbox-max-age", "none", "--inbox-per-agent", "none", "--dm-max-age", "none", "--dm-per-sender", "none", "--yes", "--plain", "--space", noAgeSpace], roots.open);
  const noneLimits = await Promise.all((["chat", "inbox", "dlv", "dm"] as const).map((s) => limitOf(ojsm, noAgeSpace, s)));
  check("none for every flag leaves every stream with no age and no count", allNone.status === 0 && noneLimits.every((l) => same(l, { maxAgeMs: 0, perSubject: NONE })), { run: shown(allNone), noneLimits });
  check("...and the receipt says only the server's storage limit then bounds them", allNone.stdout.includes("only the server's storage limit bounds a stream"), shown(allNone));
  const someAge = await run(["history", "limit", "--inbox-max-age", "2h", "--dm-max-age", "30d", "--dm-per-sender", "100", "--yes", "--json", "--space", noAgeSpace], roots.open);
  check("the inbox pair sets INBOX and DLV together, and the DM pair sets DM", someAge.status === 0 && same(await limitOf(ojsm, noAgeSpace, "inbox"), { maxAgeMs: 2 * HOUR, perSubject: NONE }) && same(await limitOf(ojsm, noAgeSpace, "dlv"), { maxAgeMs: 2 * HOUR, perSubject: NONE }) && same(await limitOf(ojsm, noAgeSpace, "dm"), { maxAgeMs: 30 * DAY, perSubject: 100 }) && rowOf(someAge.envelope, "chat") === undefined, shown(someAge));

  // ── a change, its receipt, and a repeat ──────────────────────────────────────────────────────────
  const weekly = { maxAgeMs: 7 * DAY, perSubject: 500 };
  const set = await run(["history", "limit", "--max-age", "7d", "--per-sender", "500", "--yes", "--json", "--space", space]);
  const setRow = rowOf(set.envelope, "chat");
  check("the provisioner from the space root sets the limit", set.status === 0 && set.envelope?.outcome === "ok" && set.envelope.result?.changed === true && sameView(setRow?.from, CHAT_HISTORY_DEFAULT) && sameView(setRow?.to, weekly) && setRow?.outcome === "changed", shown(set));
  check("...which the stream holds", same(await limitOf(jsm, space), weekly));
  const plain = await run(["history", "limit", "--max-age", "7d", "--per-sender", "500", "--yes", "--plain", "--space", space]);
  check("a repeat run is a no-op that writes nothing", plain.status === 0 && plain.stdout.includes("History limits unchanged") && plain.stdout.includes("7d, 500 per sender"), shown(plain));
  const repeatJson = await run(["history", "limit", "--max-age", "7d", "--yes", "--json", "--space", space]);
  check("...and says so in its envelope", repeatJson.envelope?.outcome === "no-op" && repeatJson.envelope.result?.changed === false, shown(repeatJson));

  // Posts for the prompt: one sender over the coming count on #general, one under it.
  const agent = async (name: string) => {
    provisioner ??= await (async () => {
      const ep = new CotalEndpoint({ space, servers, creds: provisionerCreds, card: { name: "limit-provisioner", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
      await ep.start();
      return ep;
    })();
    const identity = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    const creds = await provisionAgent(provisioner, auth, identity, { lifecycleUid, subscribe: [], allowSubscribe: ["general"], allowPublish: ["general"] });
    const ep = new CotalEndpoint({ space, servers, creds, lifecycleUid, card: { name, id: identity.id, kind: "agent" }, channels: [], heartbeatMs: 500, ttlMs: 10_000 });
    ep.on("error", () => {});
    await ep.start();
    endpoints.push(ep);
    return ep;
  };
  const talker = await agent("talker");
  const quiet = await agent("quiet");
  for (let i = 1; i <= 5; i++) await talker.multicast(`talk ${i}`, { channel: "general" });
  await quiet.multicast("once", { channel: "general" });
  await wait(500);

  const shownRetention = await run(["history", "general", "--plain", "--space", space]);
  check("history names the age it keeps posts for", shownRetention.stdout.includes("retention: 500 per sender on each channel, posts older than 7d expire;"), shown(shownRetention));

  // ── the prompt a lower limit asks ────────────────────────────────────────────────────────────────
  const declined = terminal(["--per-sender", "2", "--space", space]);
  const asked = await declined.until((t) => t.includes(PROMPT));
  const t = declined.text();
  check("lowering the count in a terminal asks first", asked, t.slice(-1500));
  const listed = (t.split(PROMPT)[0] ?? "").match(/#general from /g) ?? [];
  check("...naming the read time and each sender over the new count with how many go", new RegExp(`Channel posts \\(${chatStream(space)}\\), as read at \\d{4}-\\d\\d-\\d\\dT`).test(t) && /3 posts past the new count/.test(t) && /#general from local\.\S+: 3/.test(t) && listed.length === 1, t.slice(-1500));
  check("...without the operator census line, which only the delivery and DM streams need", !t.includes("As the space's operator"), t.slice(-1500));
  declined.write("\r");
  await declined.exited();
  check("Enter keeps the default No, and nothing changes", declined.code() === 0 && declined.text().includes("History limits kept") && same(await limitOf(jsm, space), weekly), { code: declined.code(), text: declined.text().slice(-600) });
  const cancelled = terminal(["--per-sender", "2", "--space", space]);
  await cancelled.until((s) => s.includes(PROMPT));
  cancelled.write("\x03");
  await cancelled.exited();
  check("Ctrl-C at the question cancels, and nothing changes", cancelled.text().includes("History limits kept") && same(await limitOf(jsm, space), weekly), { code: cancelled.code(), text: cancelled.text().slice(-600) });

  // The first stream moves while the prompt waits, as another operator's change would.
  const ageDrop = terminal(["--max-age", "1d", "--inbox-per-agent", "500", "--space", space]);
  const agePrompt = await ageDrop.until((s) => s.includes(PROMPT));
  check("lowering the age names every post older than it and the oldest retained post's time", agePrompt && /every post older than 1d \(the oldest is from \d{4}-/.test(ageDrop.text()), ageDrop.text().slice(-1500));
  check("...and asks once for both streams", (ageDrop.text().match(new RegExp(PROMPT, "g")) ?? []).length === 1 && ageDrop.text().includes(`${historyLimitStreamName(space, "inbox")} to no age limit, 500 per agent`), ageDrop.text().slice(-800));
  await setHistoryLimit(jsm, space, "chat", { maxAgeMs: 7 * DAY, perSubject: 400 }, weekly);
  ageDrop.write("y");
  ageDrop.write("\r");
  await ageDrop.exited();
  check("a first stream that moved while the prompt waited is refused CONFLICT, nothing changed", ageDrop.code() === 2 && ageDrop.text().includes("changed since it was read") && ageDrop.text().includes("nothing was changed"), { code: ageDrop.code(), text: ageDrop.text().slice(-800) });
  check("...keeping the other change, and the inbox was not attempted", same(await limitOf(jsm, space), { maxAgeMs: 7 * DAY, perSubject: 400 }) && same(await limitOf(jsm, space, "inbox"), INBOX_HISTORY_DEFAULT));

  // A later stream moves while the prompt waits: the change stops partway.
  const partial = terminal(["--per-sender", "300", "--inbox-per-agent", "600", "--dm-per-sender", "50", "--space", space]);
  await partial.until((s) => s.includes(PROMPT));
  await setHistoryLimit(jsm, space, "inbox", { maxAgeMs: 0, perSubject: 700 }, INBOX_HISTORY_DEFAULT);
  partial.write("y");
  partial.write("\r");
  await partial.exited();
  const pt = partial.text();
  const [chatNow, inboxNow, dlvNow, dmNow] = await Promise.all((["chat", "inbox", "dlv", "dm"] as const).map((s) => limitOf(jsm, space, s)));
  check("a later stream that moved is a partial change, exit 4, naming each stream's outcome", partial.code() === 4 && pt.includes(`${chatStream(space)} changed`) && pt.includes(`${historyLimitStreamName(space, "inbox")} refused`) && pt.includes(`${historyLimitStreamName(space, "dlv")} not-attempted`) && pt.includes(`${historyLimitStreamName(space, "dm")} not-attempted`), { code: partial.code(), text: pt.slice(-1200) });
  check("...where the chat stream changed, INBOX kept the other change, and DLV and DM were left as they were", same(chatNow, { maxAgeMs: 7 * DAY, perSubject: 300 }) && same(inboxNow, { maxAgeMs: 0, perSubject: 700 }) && same(dlvNow, INBOX_HISTORY_DEFAULT) && same(dmNow, { maxAgeMs: 0, perSubject: NONE }), { chatNow, inboxNow, dlvNow, dmNow });
  const split = await run(["history", "limit", "--json", "--space", space]);
  check("...and a later read shows INBOX and DLV on their different limits", sameView(rowOf(split.envelope, "inbox")?.holds, inboxNow) && sameView(rowOf(split.envelope, "dlv")?.holds, dlvNow), shown(split));
  const partialJson = await run(["history", "limit", "--inbox-per-agent", "900", "--dm-per-sender", "40", "--yes", "--json", "--space", space]);
  check("with --yes, INBOX and DLV on different limits both move to the one requested", partialJson.status === 0 && rowOf(partialJson.envelope, "inbox")?.outcome === "changed" && rowOf(partialJson.envelope, "dlv")?.outcome === "changed" && rowOf(partialJson.envelope, "dm")?.outcome === "changed", shown(partialJson));

  const raise = terminal(["--per-sender", "800", "--space", space]);
  await raise.exited();
  check("raising asks nothing and changes the limit", raise.code() === 0 && !raise.text().includes(PROMPT) && raise.text().includes("History limits changed") && same(await limitOf(jsm, space), { maxAgeMs: 7 * DAY, perSubject: 800 }), { code: raise.code(), text: raise.text().slice(-800) });
  check("...and its receipt says deleted entries do not come back, never that any were deleted", raise.text().includes("do not come back") && !/\bwere deleted\b/.test(raise.text()), raise.text().slice(-800));

  const lowered = await run(["history", "limit", "--per-sender", "2", "--yes", "--json", "--space", space]);
  const general = (await jsm.streams.info(chatStream(space), { subjects_filter: ">" })).state.subjects ?? {};
  const chatLowered = lowered.envelope?.result?.lowered?.find((l) => l.stream === chatStream(space));
  check("--yes lowers without a prompt and reports what the stream held at the read", lowered.status === 0 && chatLowered?.overCount.some((row) => row.subject.startsWith("#general from ") && row.dropped === 3) === true, shown(lowered));
  check("...and the broker keeps each sender's newest 2", Object.values(general).every((count) => count <= 2), general);

  // ── the preview per agent lifecycle and DM pair ──────────────────────────────────────────────────
  // Entries written straight to the open broker's streams, as the delivery daemon and senders would.
  const ojs = jetstream(onc);
  const [busy, light, unbound] = [newIdentity().id, newIdentity().id, newIdentity().id];
  const [busyUid, lightUid, unboundUid] = [mintLifecycleUid(), mintLifecycleUid(), mintLifecycleUid()];
  for (let i = 0; i < 6; i++) await ojs.publish(dinboxSubject(previewSpace, DEV_OWNER, busy, busyUid), `in ${i}`);
  for (let i = 0; i < 2; i++) await ojs.publish(dinboxSubject(previewSpace, DEV_OWNER, light, lightUid), `in ${i}`);
  const busyDurable = dlvDurableConfig(previewSpace, DEV_OWNER, busy, busyUid, { ackWaitMs: 600_000 });
  await ojsm.consumers.add(dlvStream(previewSpace), busyDurable);
  for (let i = 0; i < 6; i++) await ojs.publish(dlvSubject(previewSpace, DEV_OWNER, busy, busyUid), `copy ${i}`);
  // The agent took its two oldest copies and acknowledged only the newer one, as explicit acks allow.
  const taken: { ack(): void }[] = [];
  for await (const m of await (await ojs.consumers.get(dlvStream(previewSpace), busyDurable.durable_name!)).fetch({ max_messages: 2, expires: 5_000 })) taken.push(m);
  taken[1]?.ack();
  await onc.flush();
  for (let i = 0; i < 5; i++) await ojs.publish(dlvSubject(previewSpace, DEV_OWNER, unbound, unboundUid), `copy ${i}`);
  const [recipient, sender, rare] = [newIdentity().id, newIdentity().id, newIdentity().id];
  for (let i = 0; i < 5; i++) await ojs.publish(`cotal.${previewSpace}.inst.${DEV_OWNER}.${recipient}.${DEV_OWNER}.${sender}`, `dm ${i}`);
  await ojs.publish(`cotal.${previewSpace}.inst.${DEV_OWNER}.${recipient}.${DEV_OWNER}.${rare}`, "dm once");
  const preview = terminal(["--inbox-per-agent", "2", "--dm-per-sender", "2", "--dm-max-age", "1d", "--space", previewSpace], roots.open);
  await preview.until((s) => s.includes(PROMPT));
  const pv = preview.text().split(PROMPT)[0] ?? "";
  check("the preview says it is an operator census", pv.includes("As the space's operator you see every agent and DM pair these streams hold entries for."), pv.slice(-2000));
  check("...lists each inbox lifecycle over the new count with how many go, and no other", pv.includes(`${DEV_OWNER}.${busy} (lifecycle ${busyUid}): 4`) && !pv.includes(`(lifecycle ${lightUid})`) && pv.includes("These may include entries the delivery daemon has not passed on to their agents yet."), pv.slice(-2000));
  check("the rig: the busy agent holds one copy delivered and not acknowledged, and four not delivered", taken.length === 2 && await ojsm.consumers.info(dlvStream(previewSpace), busyDurable.durable_name!).then((i) => i.num_ack_pending === 1 && i.num_pending === 4), taken.length);
  check("...gives how many of each stored-copy lifecycle's removed copies were never delivered, or says it could not read them", pv.includes(`${DEV_OWNER}.${busy} (lifecycle ${busyUid}): 4, 2 not delivered yet`) && pv.includes(`${DEV_OWNER}.${unbound} (lifecycle ${unboundUid}): 3, not delivered yet: unknown`) && pv.includes("These may also include copies delivered to their agents and not acknowledged yet."), pv.slice(-2000));
  check("...and each DM pair over the new count, with every DM older than the new age", pv.includes(`to ${DEV_OWNER}.${recipient} from ${DEV_OWNER}.${sender}: 3`) && !pv.includes(`from ${DEV_OWNER}.${rare}`) && /every DM older than 1d \(the oldest is from \d{4}-/.test(pv) && pv.includes("These may include DMs their recipients have not read yet."), pv.slice(-2000));
  preview.write("\r");
  await preview.exited();
  check("...and No leaves every stream as it was", preview.code() === 0 && same(await limitOf(ojsm, previewSpace, "inbox"), INBOX_HISTORY_DEFAULT) && same(await limitOf(ojsm, previewSpace, "dm"), { maxAgeMs: 0, perSubject: NONE }), { code: preview.code(), text: preview.text().slice(-600) });

  // ── an update whose outcome the command cannot know ──────────────────────────────────────────────
  cut = { at: "update", nth: 1 };
  const first = await run(["history", "limit", "--per-sender", "300", "--inbox-per-agent", "300", "--yes", "--json", "--space", cutSpaces.update], roots.open);
  cut = undefined;
  check("a first update cut off before its reply is OPERATION_UNKNOWN, exit 3, not retried", first.status === 3 && first.envelope?.outcome === "unknown" && first.envelope.error?.code === "OPERATION_UNKNOWN" && first.envelope.error.message.includes("not retried"), shown(first));
  check("...never says nothing changed, names the read-only call, and lists no stream as changed", !first.envelope?.error?.message.includes("nothing was changed") && first.envelope?.error?.remedy?.includes("`cotal history limit` with no limit flags") === true && first.envelope?.changed?.length === 0, shown(first));
  check("...while the broker did apply it, and the inbox was not attempted", same(await limitOf(ojsm, cutSpaces.update), { maxAgeMs: 0, perSubject: 300 }) && same(await limitOf(ojsm, cutSpaces.update, "inbox"), INBOX_HISTORY_DEFAULT));
  cut = { at: "update", nth: 2 };
  const second = await run(["history", "limit", "--per-sender", "300", "--inbox-per-agent", "300", "--yes", "--json", "--space", cutSpaces.second], roots.open);
  cut = undefined;
  check("a later update cut off is OPERATION_UNKNOWN and lists the stream confirmed before it", second.status === 3 && second.envelope?.error?.code === "OPERATION_UNKNOWN" && JSON.stringify(second.envelope.changed) === JSON.stringify([chatStream(cutSpaces.second)]) && second.envelope.error.message.includes(`${historyLimitStreamName(cutSpaces.second, "dlv")} not-attempted`), shown(second));
  cut = { at: "readback" };
  const readback = await run(["history", "limit", "--per-sender", "300", "--yes", "--json", "--space", cutSpaces.readback], roots.open);
  cut = undefined;
  check("a read back cut off after the update is OPERATION_UNKNOWN too", readback.status === 3 && readback.envelope?.error?.code === "OPERATION_UNKNOWN" && same(await limitOf(ojsm, cutSpaces.readback), { maxAgeMs: 0, perSubject: 300 }), shown(readback));
  const after = await run(["history", "limit", "--json", "--space", cutSpaces.second], roots.open);
  check("...and the read-only call then shows what each stream holds", after.status === 0 && sameView(rowOf(after.envelope, "chat")?.holds, { maxAgeMs: 0, perSubject: 300 }) && sameView(rowOf(after.envelope, "dlv")?.holds, INBOX_HISTORY_DEFAULT), shown(after));
  // The read back must find the whole config canonical, not only the limit. The update is a
  // whole-config write, so a setting that drifted between the two is not the write the command made.
  const parkedRead = async (space: string, between: () => Promise<void>) => {
    cut = { at: "park" };
    unpark = undefined;
    const pending = run(["history", "limit", "--per-sender", "300", "--yes", "--json", "--space", space], roots.open);
    // The hop sets `unpark` from its socket callback, which narrowing cannot see.
    const parkedRelease = (): (() => void) | undefined => unpark;
    for (let i = 0; i < 200 && !parkedRelease(); i++) await wait(50);
    const parkedSeen = parkedRelease() !== undefined;
    await between();
    parkedRelease()?.();
    const result = await pending;
    cut = undefined;
    return { parkedSeen, result };
  };
  const control = await parkedRead(cutSpaces.parked, async () => {});
  check("control: a read back held and released with nothing changed in between confirms the change", control.parkedSeen && control.result.status === 0 && rowOf(control.result.envelope, "chat")?.outcome === "changed", { parkedSeen: control.parkedSeen, run: shown(control.result) });
  const drift = await parkedRead(cutSpaces.drift, async () => {
    const { config } = await ojsm.streams.info(chatStream(cutSpaces.drift));
    await ojsm.streams.update(chatStream(cutSpaces.drift), { ...config, max_bytes: 10 * 1024 * 1024 });
  });
  check("a stream whose other settings drift between the update and its read back is OPERATION_UNKNOWN", drift.parkedSeen && drift.result.status === 3 && drift.result.envelope?.error?.code === "OPERATION_UNKNOWN", { parkedSeen: drift.parkedSeen, run: shown(drift.result) });
  await nc.close();
  await onc.close();
} finally {
  for (const ep of endpoints.splice(0)) await ep.stop().catch(() => {});
  await provisioner?.stop().catch(() => {});
  hop.close();
  await killAndAwaitExit(broker);
  await killAndAwaitExit(openBroker);
  releaseBroker();
  releaseOpenBroker();
  releaseHome();
  for (const dir of [storeDir, openStore, home]) rmSync(dir, { recursive: true, force: true });
}
finish();
