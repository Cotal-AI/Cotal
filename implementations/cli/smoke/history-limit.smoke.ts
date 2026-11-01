/**
 * `cotal history limit` against real brokers: the refusals before any connection, the provisioner
 * minted from the space root, the prompt a lower limit asks with its read-time snapshot, a stream
 * that moved while the prompt waited, and the receipts.
 *
 * Run: pnpm smoke:history-limit   (needs nats-server on PATH; builds the binary first)
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  CHAT_HISTORY_DEFAULT,
  CotalEndpoint,
  LEGACY_CHAT_HISTORY,
  canonicalBackupStreamConfig,
  chatStream,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setChatHistoryLimit,
  setupSpaceStreams,
  standaloneConnectOpts,
  type ChatHistoryLimit,
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
const DAY = 86_400_000;
type Envelope = { outcome: string; result: { kind: string; from: ChatHistoryLimit; to: ChatHistoryLimit; changed: boolean; lowered?: { overCount: { channel: string; dropped: number }[]; olderThan: string | null } } | null; error?: { code: string; message: string } };

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
// An open space still on the legacy pair, one with no chat stream, and an auth space whose root holds no trust.
const legacySpace = `histlegacy-${randomUUID().slice(0, 8)}`;
const bareSpace = `histbare-${randomUUID().slice(0, 8)}`;
const untrusted = `histnotrust-${randomUUID().slice(0, 8)}`;

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

const run = (args: string[], cwd = roots.auth): Promise<{ status: number; stdout: string; stderr: string; envelope?: Envelope }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env: isolatedEnv, timeout: 120_000 }, (err, stdout, stderr) => {
      const lines = stdout.split("\n").filter(Boolean);
      const envelope = lines.length === 1 && lines[0]!.startsWith("{") ? (JSON.parse(lines[0]!) as Envelope) : undefined;
      resolve({ status: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr, envelope });
    });
  });
const shown = (r: { status: number; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 1200), stderr: r.stderr.slice(0, 600) });

/** One `cotal history limit` under a real terminal, so it may prompt. */
function terminal(args: string[]) {
  const pty = nodePty([BIN, "history", "limit", ...args], { cwd: roots.auth, env: isolatedEnv as Record<string, string>, cols: 160, rows: 40 });
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
  await ojsm.streams.add(canonicalBackupStreamConfig(legacySpace, chatStream(legacySpace), LEGACY_CHAT_HISTORY));
  saveSpaceAuth(authDir(roots.auth), auth);
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = isolatedEnv.COTAL_HOME;
  try {
    recordMesh({ space, server: servers, root: roots.auth, mode: "auth", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: untrusted, server: servers, root: roots.untrusted, mode: "auth", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: legacySpace, server: openServers, root: roots.open, mode: "open", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: bareSpace, server: openServers, root: roots.open, mode: "open", origin: "manual", ts: new Date().toISOString() });
  } finally {
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
  }
  const limitOf = async (m: typeof jsm, s: string): Promise<ChatHistoryLimit> => {
    const { config } = await m.streams.info(chatStream(s));
    return { maxAgeMs: config.max_age / 1_000_000, perSender: config.max_msgs_per_subject };
  };
  const same = (a: ChatHistoryLimit | undefined, b: ChatHistoryLimit) => a !== undefined && a.maxAgeMs === b.maxAgeMs && a.perSender === b.perSender;

  // ── refusals before any connection ──────────────────────────────────────────────────────────────
  for (const [args, what, needle] of [
    [[], "no flag", "needs --max-age, --per-sender or both"],
    [["--max-age", "1m", "--yes"], "an age below 2m", "at least 2m"],
    [["--max-age", "5x", "--yes"], "an age that is not one", "--max-age takes an age"],
    [["--per-sender", "0", "--yes"], "a count of 0", "at least 1"],
    [["--max-age", "4000d", "--yes"], "an age past 3650d", "at most 3650d"],
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
  check("a space with no chat stream is refused TARGET_NOT_FOUND", bare.status === 2 && bare.envelope?.error?.code === "TARGET_NOT_FOUND", shown(bare));
  check("...and no chat stream was created", bareCreated === false);

  // ── the legacy pair needs an age ─────────────────────────────────────────────────────────────────
  const countOnly = await run(["history", "limit", "--per-sender", "500", "--yes", "--json", "--space", legacySpace], roots.open);
  check("a stream with no age limit refuses a count alone, naming --max-age", countOnly.status === 1 && countOnly.envelope?.error?.code === "USAGE_INVALID" && countOnly.envelope.error.message.includes("pass --max-age as well"), shown(countOnly));
  check("...and changed nothing", same(await limitOf(ojsm, legacySpace), LEGACY_CHAT_HISTORY));
  const withAge = await run(["history", "limit", "--max-age", "30d", "--per-sender", "500", "--yes", "--json", "--space", legacySpace], roots.open);
  check("an open space takes an age and a count on a bare connection", withAge.status === 0 && withAge.envelope?.result?.changed === true && same(await limitOf(ojsm, legacySpace), { maxAgeMs: 30 * DAY, perSender: 500 }), shown(withAge));

  // ── a change, its receipt, and a repeat ──────────────────────────────────────────────────────────
  const weekly = { maxAgeMs: 7 * DAY, perSender: 500 };
  const set = await run(["history", "limit", "--max-age", "7d", "--per-sender", "500", "--yes", "--json", "--space", space]);
  check("the provisioner from the space root sets the limit", set.status === 0 && set.envelope?.outcome === "ok" && set.envelope.result?.changed === true && same(set.envelope.result.from, CHAT_HISTORY_DEFAULT) && same(set.envelope.result.to, weekly), shown(set));
  check("...which the stream holds", same(await limitOf(jsm, space), weekly));
  const plain = await run(["history", "limit", "--max-age", "7d", "--per-sender", "500", "--yes", "--plain", "--space", space]);
  check("a repeat run is a no-op that writes nothing", plain.status === 0 && plain.stdout.includes("History limit unchanged") && plain.stdout.includes("7d, 500 per sender"), shown(plain));
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
  const asked = await declined.until((t) => t.includes("Lower the chat history limit"));
  const t = declined.text();
  check("lowering the count in a terminal asks first", asked, t.slice(-1500));
  const listed = (t.split("Lower the chat")[0] ?? "").match(/#general: \d+ from /g) ?? [];
  check("...naming the read time and each sender over the new count with how many go", /As read at \d{4}-\d\d-\d\dT/.test(t) && /3 posts past the new per-sender count/.test(t) && /#general: 3 from local\./.test(t) && listed.length === 1, t.slice(-1500));
  declined.write("\r");
  await declined.exited();
  check("Enter keeps the default No, and nothing changes", declined.code() === 0 && declined.text().includes("History limit kept") && same(await limitOf(jsm, space), weekly), { code: declined.code(), text: declined.text().slice(-600) });

  const ageDrop = terminal(["--max-age", "1d", "--space", space]);
  const agePrompt = await ageDrop.until((s) => s.includes("Lower the chat history limit"));
  check("lowering the age names every post older than it and the oldest retained post's time", agePrompt && /every post older than 1d \(the oldest retained post is from \d{4}-/.test(ageDrop.text()), ageDrop.text().slice(-1200));
  // The stream moves while the prompt waits, as another operator's change would.
  await setChatHistoryLimit(jsm, space, { maxAgeMs: 7 * DAY, perSender: 400 }, weekly);
  ageDrop.write("y");
  ageDrop.write("\r");
  await ageDrop.exited();
  check("a stream that moved while the prompt waited is refused CONFLICT", ageDrop.code() === 2 && ageDrop.text().includes("changed since it was read") && ageDrop.text().includes("nothing was changed"), { code: ageDrop.code(), text: ageDrop.text().slice(-800) });
  check("...and keeps the other change", same(await limitOf(jsm, space), { maxAgeMs: 7 * DAY, perSender: 400 }));

  const raise = terminal(["--per-sender", "800", "--space", space]);
  await raise.exited();
  check("raising asks nothing and changes the limit", raise.code() === 0 && !raise.text().includes("Lower the chat") && raise.text().includes("History limit changed") && same(await limitOf(jsm, space), { maxAgeMs: 7 * DAY, perSender: 800 }), { code: raise.code(), text: raise.text().slice(-800) });
  check("...and its receipt says deleted posts do not come back, never that posts were deleted", raise.text().includes("do not come back") && !/\bwere deleted\b/.test(raise.text()), raise.text().slice(-800));

  const lowered = await run(["history", "limit", "--per-sender", "2", "--yes", "--json", "--space", space]);
  const general = (await jsm.streams.info(chatStream(space), { subjects_filter: ">" })).state.subjects ?? {};
  check("--yes lowers without a prompt and reports what the stream held at the read", lowered.status === 0 && lowered.envelope?.result?.lowered?.overCount.some((row) => row.channel === "general" && row.dropped === 3) === true, shown(lowered));
  check("...and the broker keeps each sender's newest 2", Object.values(general).every((count) => count <= 2), general);
  await nc.close();
  await onc.close();
} finally {
  for (const ep of endpoints.splice(0)) await ep.stop().catch(() => {});
  await provisioner?.stop().catch(() => {});
  await killAndAwaitExit(broker);
  await killAndAwaitExit(openBroker);
  releaseBroker();
  releaseOpenBroker();
  releaseHome();
  for (const dir of [storeDir, openStore, home]) rmSync(dir, { recursive: true, force: true });
}
finish();
