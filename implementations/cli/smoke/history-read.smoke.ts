/**
 * `cotal history [channel]` on the structured output contract, against brokers this suite owns. Real
 * agents post to channels and DM each other; the CLI child reads with its own one-shot credential.
 * Covers one channel and every channel, `--limit`, `--since` by sequence and by time, `--from` and
 * `--grep`, `--dms`, the usage refusals, a credential that may not read history, `--follow` as NDJSON
 * and as lines, and a retention gap (on an open broker, one sender posts past the chat stream's
 * per-sender limit). The user-auth result rendering is driven against a stand-in endpoint.
 * smoke:ps-user-mode and smoke:user-spawn:live exercise the native user-auth history path.
 *
 * Isolation: every CLI child gets a sandboxed HOME / XDG_CONFIG_HOME / TMPDIR / COTAL_HOME, and
 * inherited COTAL_* is stripped.
 *
 * Run: pnpm smoke:history-read
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BACKUP_MAX_MSGS_PER_SUBJECT,
  CotalEndpoint,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { createSuite, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { authDir, recordMesh, saveSpaceAuth, setCurrent } from "@cotal-ai/workspace";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { clean, nodePty } from "./_console-pty.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Item = { seq: number | null; id: string; ts: string; channel: string | null; to: string | null; from: { id: string; name: string }; text: string };
type Result = {
  kind: string;
  channels: string[];
  window: { limit: number; read: number; olderRetained: boolean | null; reachesSince: boolean | null };
  retention: { perSender: number | null; gaps: { channel: string; name: string | null; retained: number }[] } | null;
  replay: { channel: string; replay: boolean | null }[];
  items: Item[];
};
type Envelope = { outcome: string; completeness: string; command: string; target: unknown; result: Result | null; warnings: { code: string }[]; error?: { code: string; message: string } };

const space = `histsmoke-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(storeDir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(storeDir, "js") }));
const broker = spawn("nats-server", ["-c", join(storeDir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, storeDir);
// An open broker for the retention gap, so the auth space's channels stay small.
const openSpace = `histgap-${randomUUID().slice(0, 8)}`;
// A space on the open broker that nothing has set up, so it has no channel registry bucket.
const bareSpace = `histbare-${randomUUID().slice(0, 8)}`;
const openPort = await pickFreePort();
const openServers = `nats://127.0.0.1:${openPort}`;
const openStore = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const openBroker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(openPort), "-sd", join(openStore, "js")], { stdio: "ignore" });
const releaseOpenBroker = teardownOnSignal(openBroker, openStore);

const home = mkdtempSync(join(tmpdir(), "cotal-history-home-"));
const releaseHome = teardownPathOnSignal(home);
mkdirSync(join(home, ".cotal"), { recursive: true });
const xdg = join(home, "xdg");
mkdirSync(xdg);
const meshRoot = join(home, "mesh-root");
mkdirSync(join(meshRoot, ".cotal"), { recursive: true });
const openRoot = join(home, "open-root");
mkdirSync(join(openRoot, ".cotal"), { recursive: true });
const shell = join(home, "shell");
mkdirSync(join(shell, ".cotal"), { recursive: true });

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_") || key === "FORCE_COLOR" || key === "NO_COLOR") delete cleanEnv[key];
const isolatedEnv: NodeJS.ProcessEnv = { ...cleanEnv, HOME: home, USERPROFILE: home, TMPDIR: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1" };

const run = (args: string[]): Promise<{ status: number; stdout: string; stderr: string; envelope?: Envelope }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: shell, env: isolatedEnv, timeout: 120_000 }, (err, stdout, stderr) => {
      const lines = stdout.split("\n").filter(Boolean);
      const envelope = lines.length === 1 && lines[0]!.startsWith("{") ? (JSON.parse(lines[0]!) as Envelope) : undefined;
      resolve({ status: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr, envelope });
    });
  });
const shown = (r: { status: number; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 1500), stderr: r.stderr.slice(0, 600) });
const texts = (r: { envelope?: Envelope }) => (r.envelope?.result?.items ?? []).map((i) => i.text);

/** A follow child: its stdout lines as they arrive, and a way to wait for one. */
function follow(args: string[]) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: shell, env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let buffered = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    const parts = buffered.split("\n");
    buffered = parts.pop()!;
    lines.push(...parts.filter(Boolean));
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const until = async (pred: (line: string) => boolean, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (lines.some(pred)) return true;
      await wait(100);
    }
    return false;
  };
  return { child, lines, exited, until, stderr: () => stderr };
}

const endpoints: CotalEndpoint[] = [];
let provisioner: CotalEndpoint | undefined;
try {
  for (const s of [servers, openServers]) {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      ready = await isReachable(s);
      if (!ready) await wait(100);
    }
    check(`control: the owned broker at ${s} is ready`, ready, s);
  }
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  await seedChannelRegistry({ servers, space, creds: provisionerCreds, file: { channels: { general: { replay: true, replayWindow: "24h" }, ops: { replay: false } } } });
  await setupSpaceStreams({ servers: openServers, space: openSpace });
  saveSpaceAuth(authDir(meshRoot), auth);
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = isolatedEnv.COTAL_HOME;
  try {
    recordMesh({ space, server: servers, root: meshRoot, mode: "auth", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: openSpace, server: openServers, root: openRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: bareSpace, server: openServers, root: openRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
    setCurrent(space);
  } finally {
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
  }
  provisioner = new CotalEndpoint({ space, servers, creds: provisionerCreds, card: { name: "history-provisioner", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  await provisioner.start();

  const agent = async (name: string) => {
    const identity = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    const creds = await provisionAgent(provisioner!, auth, identity, { lifecycleUid, subscribe: [], allowSubscribe: ["general", "ops"], allowPublish: ["general", "ops"] });
    const ep = new CotalEndpoint({ space, servers, creds, lifecycleUid, card: { name, id: identity.id, kind: "agent" }, channels: [], heartbeatMs: 500, ttlMs: 10_000 });
    ep.on("error", () => {});
    await ep.start();
    endpoints.push(ep);
    return ep;
  };
  const alice = await agent("alice");
  const bob = await agent("bob");
  await alice.multicast("deploy started", { channel: "general" });
  await bob.multicast("looks good", { channel: "general" });
  await wait(1_100);
  const midpoint = new Date().toISOString();
  await wait(100);
  await alice.multicast("deploy finished", { channel: "general" });
  await bob.multicast("paging ops", { channel: "ops" });
  const bobId = `${bob.principal.owner}.${bob.principal.actor}`;
  await alice.unicast(bobId, "a private note");
  await wait(600);

  // ── one channel ─────────────────────────────────────────────────────────────────────────────────
  const general = await run(["history", "general", "--json"]);
  const items = general.envelope?.result?.items ?? [];
  check("history general --json is one complete ok envelope", general.status === 0 && general.envelope?.outcome === "ok" && general.envelope.completeness === "complete" && general.envelope.command === "history", shown(general));
  check("it holds the channel's messages oldest first, newest last", JSON.stringify(texts(general)) === JSON.stringify(["deploy started", "looks good", "deploy finished"]), texts(general));
  check("each message carries its stream sequence, channel and sender", items.every((i) => typeof i.seq === "number" && i.channel === "general") && items[0]?.from.name === "alice" && items[1]!.seq! > items[0]!.seq!, items);
  check("the window says nothing older is retained", general.envelope?.result?.window.olderRetained === false && general.envelope.result.window.read === 3, general.envelope?.result?.window);
  check("retention names its per-sender limit, and the channel's replay setting is reported", typeof general.envelope?.result?.retention?.perSender === "number" && general.envelope.result.replay.some((r) => r.channel === "general" && r.replay === true), { retention: general.envelope?.result?.retention, replay: general.envelope?.result?.replay });
  check("a DM is not in channel history", !texts(general).includes("a private note"), texts(general));

  const all = await run(["history", "--json"]);
  check("history with no channel reads every channel, newest last", JSON.stringify(texts(all)) === JSON.stringify(["deploy started", "looks good", "deploy finished", "paging ops"]) && all.envelope?.result?.items.at(-1)?.channel === "ops", texts(all));

  const two = await run(["history", "general", "--limit", "2", "--json"]);
  check("--limit 2 keeps the two newest and says older ones are retained", JSON.stringify(texts(two)) === JSON.stringify(["looks good", "deploy finished"]) && two.envelope?.result?.window.olderRetained === true, two.envelope?.result);

  const bySeq = await run(["history", "general", "--since", String(items[0]?.seq), "--json"]);
  check("--since a sequence keeps only later messages", JSON.stringify(texts(bySeq)) === JSON.stringify(["looks good", "deploy finished"]) && bySeq.envelope?.result?.window.reachesSince === true, texts(bySeq));
  const byTime = await run(["history", "general", "--since", midpoint, "--json"]);
  check("--since a time keeps only messages after it", JSON.stringify(texts(byTime)) === JSON.stringify(["deploy finished"]), texts(byTime));
  const narrow = await run(["history", "general", "--limit", "1", "--since", String(items[0]?.seq), "--json"]);
  check("a window that does not reach back to --since says so", narrow.envelope?.result?.window.reachesSince === false, narrow.envelope?.result?.window);
  const fromBob = await run(["history", "--from", "bob", "--json"]);
  check("--from keeps one sender's messages", JSON.stringify(texts(fromBob)) === JSON.stringify(["looks good", "paging ops"]), texts(fromBob));
  const grep = await run(["history", "--grep", "DEPLOY", "--json"]);
  check("--grep matches text case-insensitively within the window", JSON.stringify(texts(grep)) === JSON.stringify(["deploy started", "deploy finished"]) && grep.envelope?.result?.window.read === 4, { texts: texts(grep), window: grep.envelope?.result?.window });

  const dms = await run(["history", "--dms", "--json"]);
  check("--dms adds DMs, each naming its recipient", dms.status === 0 && (dms.envelope?.result?.items ?? []).some((i) => i.text === "a private note" && i.channel === null && i.to === bobId), shown(dms));

  const plain = await run(["history", "general", "--plain"]);
  check("the plain report is a table and names the retention and replay", plain.status === 0 && /^TIME\s+WHERE\s+FROM\s+MESSAGE/m.test(plain.stdout) && /#general\s+alice\s+deploy started/.test(plain.stdout) && /retention: /.test(plain.stdout) && /#general replay to new members: on \(24h\)/.test(plain.stdout) && !/\x1b\[/.test(plain.stdout), shown(plain));
  const localTime = items[0] ? new Date(items[0].ts).toLocaleTimeString() : "";
  check("the plain report shows each message's local time, not the ISO time JSON carries", localTime !== "" && plain.stdout.includes(localTime) && !/\d{4}-\d\d-\d\dT\d\d:/.test(plain.stdout) && /^\d{4}-\d\d-\d\dT/.test(items[0]!.ts), { localTime, stdout: plain.stdout.slice(0, 600) });

  // ── usage ───────────────────────────────────────────────────────────────────────────────────────
  for (const args of [["general", "--dms"], ["--limit", "0"], ["--limit", "1001"], ["--since", "yesterday-ish"], ["--dms", "--since", "5"], ["general", "ops"], ["--force"], ["--json", "--plain"]]) {
    const r = await run(["history", ...args, "--json"]);
    check(`history ${args.join(" ")} is one USAGE_INVALID envelope, exit 1`, r.status === 1 && r.envelope?.error?.code === "USAGE_INVALID", shown(r));
  }

  const unavailable = `nats://127.0.0.1:${await pickFreePort()}`;
  const tooOld = await run(["history", "--since", "999999999999999999999999999999999999999999999999d", "--server", unavailable, "--json"]);
  check("an unrepresentable --since age is a usage error before connecting", tooOld.status === 1 && tooOld.envelope?.error?.code === "USAGE_INVALID", shown(tooOld));
  const unsafeSequence = await run(["history", "--since", "9007199254740993", "--server", unavailable, "--json"]);
  check("an inexact --since sequence is a usage error before connecting", unsafeSequence.status === 1 && unsafeSequence.envelope?.error?.code === "USAGE_INVALID", shown(unsafeSequence));

  // ── a credential that may not read history ──────────────────────────────────────────────────────
  const probe = join(home, "probe.creds");
  writeFileSync(probe, await mintCreds(auth, newIdentity(), "probe"), { mode: 0o600 });
  const denied = await run(["history", "general", "--json", "--creds", probe, "--space", space, "--server", servers]);
  check("a credential that may not read history is a PERMISSION_DENIED refusal, exit 2, not an empty page", denied.status === 2 && denied.envelope?.outcome === "refused" && denied.envelope.error?.code === "PERMISSION_DENIED" && denied.envelope.result === null, shown(denied));

  // ── --follow ────────────────────────────────────────────────────────────────────────────────────
  const f = follow(["history", "general", "--follow", "--json"]);
  const snap = await f.until((l) => l.includes('"type":"snapshot"'));
  const records = () => f.lines.map((l) => JSON.parse(l) as { schemaVersion: number; stream: string; type: string; data: { text?: string; reason?: string; items?: Item[] } });
  check("--follow --json starts with one snapshot record of the window", snap && records()[0]?.type === "snapshot" && records()[0]?.stream === "history" && records()[0]?.schemaVersion === 1 && records()[0]?.data.items?.length === 3, { lines: f.lines.slice(0, 2), stderr: f.stderr() });
  await alice.multicast("live one", { channel: "general" });
  await bob.multicast("not this channel", { channel: "ops" });
  const event = await f.until((l) => l.includes("live one"));
  check("a message sent while following is one event record", event && records().filter((r) => r.type === "event").map((r) => r.data.text).join() === "live one", f.lines);
  f.child.kill("SIGINT");
  const code = await f.exited;
  check("an interrupted follow ends with an end record and exit 0", code === 0 && records().at(-1)?.type === "end" && records().at(-1)?.data.reason === "interrupted", { code, last: f.lines.at(-1), stderr: f.stderr() });
  check("every follow line is one parseable stream record", f.lines.every((l) => { try { const r = JSON.parse(l); return r.schemaVersion === 1 && r.stream === "history"; } catch { return false; } }), f.lines);

  const fp = follow(["history", "--follow", "--plain", "--grep", "plain"]);
  await fp.until((l) => /replay to new members/.test(l));
  await bob.multicast("a plain line", { channel: "ops" });
  await alice.multicast("filtered out", { channel: "general" });
  const shownLine = await fp.until((l) => l.includes("a plain line"));
  fp.child.kill("SIGINT");
  await fp.exited;
  check("--follow --plain appends each matching message as a line", shownLine && fp.lines.some((l) => /#ops\s+bob: a plain line/.test(l)) && !fp.lines.some((l) => l.includes("filtered out")), fp.lines.slice(-4));
  check("a followed line shows the local time, not the ISO time", fp.lines.some((l) => /bob: a plain line/.test(l) && !/^\d{4}-\d\d-\d\dT/.test(l)), fp.lines.slice(-4));

  // A followed line is drawn for the terminal it is shown in, as the window above it is.
  const tty = nodePty([BIN, "history", "--follow", "--grep", "wrapped"], { cwd: shell, env: isolatedEnv as Record<string, string>, cols: 60, rows: 30 });
  let ttyOut = "";
  tty.onData((d) => (ttyOut += d));
  for (const t0 = Date.now(); Date.now() - t0 < 30_000 && !/replay to new members/.test(clean(ttyOut)); ) await wait(100);
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
  await bob.multicast(`wrapped ${words}`, { channel: "ops" });
  for (const t0 = Date.now(); Date.now() - t0 < 30_000 && !clean(ttyOut).includes("papa"); ) await wait(100);
  tty.kill();
  const ttyLines = clean(ttyOut).split(/\r?\n/);
  check("a followed line wraps at word boundaries in a 60-column terminal", clean(ttyOut).includes("papa") && ttyLines.every((l) => l.length <= 60) && words.split(" ").every((w) => ttyLines.some((l) => new RegExp(`\\b${w}\\b`).test(l))), ttyLines.slice(-6));

  // ── a retention gap ─────────────────────────────────────────────────────────────────────────────
  {
    const cap = BACKUP_MAX_MSGS_PER_SUBJECT;
    const talker = new CotalEndpoint({ space: openSpace, servers: openServers, card: { name: "carol", kind: "agent" }, channels: ["general"], heartbeatMs: 500 });
    const quiet = new CotalEndpoint({ space: openSpace, servers: openServers, card: { name: "dave", kind: "agent" }, channels: ["general"], heartbeatMs: 500 });
    for (const ep of [talker, quiet]) {
      ep.on("error", () => {});
      await ep.start();
      endpoints.push(ep);
    }
    // Two past the limit, so carol's two oldest are gone.
    for (let i = 1; i <= cap + 2; i++) await talker.multicast(`carol ${i}`, { channel: "general" });
    await quiet.multicast("dave once", { channel: "general" });
    await wait(500);
    const gap = await run(["history", "general", "--space", openSpace, "--limit", "1000", "--json"]);
    const r = gap.envelope?.result;
    const got = texts(gap);
    check("the newest thousand are carol's last and dave's one, and older ones are retained", gap.status === 0 && got.length === 1000 && got.at(-1) === "dave once" && got.at(-2) === `carol ${cap + 2}` && r?.window.olderRetained === true, { status: gap.status, n: got.length, head: got.slice(0, 2), tail: got.slice(-2), window: r?.window });
    check("the gap is named: carol is at the per-sender limit on #general, dave is not", r?.retention?.perSender === cap && r.retention.gaps.length === 1 && r.retention.gaps[0]?.name === "carol" && r.retention.gaps[0].retained === cap, r?.retention);
    check("a retention gap is a fact about history, not a partial read", gap.envelope?.outcome === "ok" && gap.envelope.completeness === "complete", { outcome: gap.envelope?.outcome, completeness: gap.envelope?.completeness, warnings: gap.envelope?.warnings });
    const gapPlain = await run(["history", "general", "--space", openSpace, "--limit", "3", "--plain"]);
    check("the report names the gap", new RegExp(`gap: #general holds ${cap} from carol, the per-sender limit, so their older messages there are gone`).test(gapPlain.stdout), gapPlain.stdout);
  }

  // ── destructive clear accepts no selection or read mode ──────────────────────────────────────
  {
    const writer = new CotalEndpoint({ space: openSpace, servers: openServers, channels: [], consume: false, registerPresence: false, watchPresence: false, card: { name: "clear-sentinel", kind: "endpoint" } });
    endpoints.push(writer);
    await writer.start();
    const cases = [
      ["an extra channel", ["general"]],
      ["--since", ["--since", "1h"]],
      ["--limit", ["--limit", "1"]],
      ["--from", ["--from", "nobody"]],
      ["--grep", ["--grep", "no matching sentinel"]],
      ["--follow", ["--follow"]],
    ] as const;
    for (const [label, args] of cases) {
      const cleared = await run(["history", "clear", "--force", "--space", openSpace]);
      const empty = await run(["history", "--space", openSpace, "--json"]);
      if (cleared.status !== 0 || empty.status !== 0 || empty.envelope?.result?.items.length !== 0)
        throw new Error(`clear fixture's valid purge control failed: ${JSON.stringify({ cleared: shown(cleared), empty: shown(empty) })}`);
      const sentinels = [`general sentinel ${randomUUID()}`, `ops sentinel ${randomUUID()}`];
      await writer.multicast(sentinels[0]!, { channel: "general" });
      await writer.multicast(sentinels[1]!, { channel: "ops" });
      const before = await run(["history", "--space", openSpace, "--json"]);
      if (before.status !== 0 || texts(before).length !== 2 || !sentinels.every((text) => texts(before).includes(text)))
        throw new Error(`clear fixture did not seed both channels: ${JSON.stringify(shown(before))}`);
      const refused = await run(["history", "clear", ...args, "--force", "--space", openSpace]);
      const after = await run(["history", "--space", openSpace, "--json"]);
      check(`history clear refuses ${label} before purging either channel`, refused.status === 1 && after.status === 0 && texts(after).length === 2 && sentinels.every((text) => texts(after).includes(text)), { refused: shown(refused), after: shown(after) });
    }
  }

  {
    const before = await run(["history", "--dms", "--json"]);
    const cleared = await run(["history", "clear", "--force", "--dms"]);
    const after = await run(["history", "--dms", "--json"]);
    check("explicit history clear with --dms still purges authorized channel and DM history", before.status === 0 && before.envelope?.result?.items.some((item) => item.channel !== null) === true && before.envelope?.result?.items.some((item) => item.to !== null) === true && cleared.status === 0 && after.status === 0 && after.envelope?.result?.items.length === 0, { before: shown(before), cleared: shown(cleared), after: shown(after) });
  }

  // ── a space with no channel registry ────────────────────────────────────────────────────────────
  {
    const bare = await run(["history", "general", "--space", bareSpace, "--json"]);
    const r = bare.envelope?.result;
    check("a space with no channel registry has the built-in replay policy, and the read is complete", bare.status === 0 && bare.envelope?.completeness === "complete" && JSON.stringify(r?.replay) === JSON.stringify([{ channel: "general", replay: true, window: null }]) && r?.items.length === 0, shown(bare));
  }
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await provisioner?.stop().catch(() => {});
  await killAndAwaitExit(broker);
  await killAndAwaitExit(openBroker);
  releaseBroker();
  releaseOpenBroker();
  releaseHome();
}

// ── a user-auth identity renders channel-scoped pages ─────────────────────────────────────────
{
  const { readWindow } = await import("../src/commands/history.js");
  const msg = (id: string, ts: number, channel: string, text: string) => ({ id, ts, space: "s", channel, from: { id: "u_o.a", name: "ann" }, parts: [{ kind: "text", text }] });
  const pages: Record<string, { items: unknown[]; complete: boolean } | Error> = {
    general: { items: [msg("1", 1_000, "general", "hello")], complete: true },
    secret: new Error("readHistory: channel secret is outside the caller's read ACL"),
    ops: { items: [msg("2", 2_000, "ops", "on call")], complete: false },
  };
  const ep = {
    listChannels: async () => [{ channel: "general", messages: 1 }, { channel: "secret", messages: 4 }, { channel: "ops", messages: 9 }],
    channelHistoryPage: async (ch: string) => {
      const page = pages[ch]!;
      if (page instanceof Error) throw page;
      return page;
    },
    chatRetention: async () => ({ perSender: 1000, maxAgeMs: null, senders: [] }),
  } as unknown as import("@cotal-ai/core").CotalEndpoint;
  const conn = { space: "s", server: "nats://x", tls: false, mode: "user" } as unknown as import("@cotal-ai/workspace").Connection;
  const req = { channel: undefined, dms: false, limit: 50, since: undefined, from: undefined, grep: undefined, target: {} };
  const every = await readWindow(ep, conn, req);
  check("a user reads each channel it may, and a denied one is named, not shown empty", every.result.items.length === 2 && JSON.stringify(every.result.denied) === '["secret"]' && every.warnings.some((w) => w.code === "CHANNELS_DENIED"), every);
  check("a channel page that is not complete means older retained messages exist", every.result.window.olderRetained === true, every.result.window);
  const refused = await readWindow(ep, conn, { ...req, channel: "secret" }).then(() => undefined, (e: { code?: string }) => e.code);
  check("a user naming a channel outside the grant is refused with PERMISSION_DENIED", refused === "PERMISSION_DENIED", refused);
  const dmRefused = await readWindow(ep, conn, { ...req, dms: true }).then(() => undefined, (e: { code?: string }) => e.code);
  check("a user asking for DMs is refused with PERMISSION_DENIED", dmRefused === "PERMISSION_DENIED", dmRefused);
  const seqRefused = await readWindow(ep, conn, { ...req, since: { kind: "seq", seq: 3, text: "3" } }).then(() => undefined, (e: { code?: string }) => e.code);
  check("a user asking for --since a sequence is refused with UNSUPPORTED", seqRefused === "UNSUPPORTED", seqRefused);
}

finish();
