/**
 * Backup and restore of the chat stream's history limit, on a real stack: a restore holds the chat
 * stream at no age while it checks the restored state, then sets the age the backup recorded, and a
 * backup on the old settings restores on them and moves at the next start. A resume moves nothing,
 * and a start that fails after the move says so in its error.
 *
 * The first scenario waits out the two-minute minimum age between the backup and the restore, so
 * its posts are older than the recorded age when the restore checks them. A restore that applied
 * the age before those checks would watch the broker delete them and refuse. The last scenario runs
 * `cotal setup --start`, whose start happens in a child process, and checks that setup reports the
 * move both when its start then fails and when it goes on.
 *
 * Run: pnpm smoke:chat-history-restore:live   (needs nats-server on PATH)
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import { CHAT_HISTORY_DEFAULT, LEGACY_CHAT_HISTORY, PLANE3_MAX_MSGS_PER_SUBJECT, channelBucket, chatStream, dlvStream, inboxStream, type ChatHistoryLimit } from "@cotal-ai/core";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { infrastructureMaintenancePermissions } from "../../implementations/cli/src/lib/isolated-broker.js";

const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const worktree = resolve(import.meta.dirname, "..", "..");
const cliPath = join(worktree, "bin", "cotal.ts");
const tsx = join(worktree, "node_modules", ".bin", "tsx");

function sandbox(label: string) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-chl-${label}-root-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-chl-${label}-home-`)));
  const configDir = join(home, "xdg");
  const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
  const env = { ...process.env, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
  const runWith = (extra: Record<string, string>, ...args: string[]): SpawnSyncReturns<string> => {
    const options = { cwd: root, env: { ...env, ...extra }, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(anchor, args, options);
    return spawnSync(tsx, [cliPath, ...args], options);
  };
  const run = (...args: string[]) => runWith({}, ...args);
  const shown = (r: SpawnSyncReturns<string>) => ({ status: r.status, stdout: r.stdout?.slice(-1500), stderr: r.stderr?.slice(-1500) });
  return { root, home, run, runWith, shown, cleanup: () => { for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true }); } };
}

const limitOf = (config: { max_age?: number; max_msgs_per_subject?: number }): ChatHistoryLimit => ({ maxAgeMs: (config.max_age ?? 0) / 1_000_000, perSender: config.max_msgs_per_subject ?? Number.NaN });
const same = (a: ChatHistoryLimit, b: ChatHistoryLimit) => a.maxAgeMs === b.maxAgeMs && a.perSender === b.perSender;

// The login that sets the age reaches the chat stream alone.
{
  const permissions = infrastructureMaintenancePermissions("conn", ["CHAT_x"], ["CHAT_x"]) as { pub: { allow: string[] } };
  const updates = permissions.pub.allow.filter((subject) => subject.startsWith("$JS.API.STREAM.UPDATE."));
  check("the restore's age login may update the chat stream and no other", updates.length === 1 && updates[0] === "$JS.API.STREAM.UPDATE.CHAT_x" && !permissions.pub.allow.some((subject) => subject.includes("OBJ_")), permissions.pub.allow);
}

// ── the recorded age lands after the restore's checks ──────────────────────────────────────────────
{
  const s = sandbox("age");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "chl_restore_age";
  const artifact = join(s.root, "backup");
  const recorded = { maxAgeMs: 2 * MIN, perSender: 2500 };
  let up = false;
  try {
    const started = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = started.status === 0;
    check("control: the open stack starts", up, s.shown(started));
    const nc = await connect({ servers: server });
    const js = jetstream(nc);
    for (const i of [1, 2, 3]) await js.publish(`cotal.${space}.chat.o.a.general`, JSON.stringify({ i }));
    const writtenAt = Date.now();
    await nc.close();
    const set = s.run("history", "limit", "--max-age", "2m", "--per-sender", "2500", "--yes", "--json", "--space", space);
    check("control: the source takes a 2-minute age and a count above 1000", set.status === 0, s.shown(set));
    const preserved = s.run("down", "--preserve-state");
    up = preserved.status !== 0;
    const backed = s.run("backup", "create", artifact);
    check("control: the backup is taken", preserved.status === 0 && backed.status === 0, { down: s.shown(preserved), backup: s.shown(backed) });
    const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")) as { streams: { stream: string; config: { max_age?: number; max_msgs_per_subject?: number } }[] };
    const chat = manifest.streams.find((row) => row.stream === chatStream(space));
    check("the backup records the chat stream's limit", chat !== undefined && same(limitOf(chat.config), recorded), chat?.config);

    const due = writtenAt + 2 * MIN + 5_000 - Date.now();
    if (due > 0) await wait(due);
    const restored = s.run("up", "--restore", artifact, "--detach", "--server", server, "--space", space);
    up = restored.status === 0;
    check("a restore whose posts are older than the recorded age passes its checks", restored.status === 0, s.shown(restored));
    const rc = await connect({ servers: server });
    const jsm = await jetstreamManager(rc);
    const info = await jsm.streams.info(chatStream(space));
    check("...then holds the recorded age and count", info.config.max_age === nanos(recorded.maxAgeMs) && info.config.max_msgs_per_subject === recorded.perSender, limitOf(info.config));
    let messages = info.state.messages;
    for (let i = 0; i < 50 && messages !== 0; i++) { await wait(200); messages = (await jsm.streams.info(chatStream(space))).state.messages; }
    check("...and the broker deletes the posts older than it", messages === 0, messages);
    const plane3 = await Promise.all([inboxStream(space), dlvStream(space)].map(async (name) => (await jsm.streams.info(name)).config));
    check("INBOX and DLV come back with their own bound", plane3.every((c) => c.max_msgs_per_subject === PLANE3_MAX_MSGS_PER_SUBJECT && c.max_age === 0), plane3.map((c) => [c.name, c.max_msgs_per_subject, c.max_age]));
    await rc.close();
  } catch (e) {
    // A throw ends the scenario, not the suite, so the next one still runs and the summary prints.
    check(`the recorded-age scenario ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
  } finally {
    if (up) s.run("down");
    s.cleanup();
  }
}

// ── a backup on the old settings ───────────────────────────────────────────────────────────────────
{
  const s = sandbox("legacy");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "chl_restore_legacy";
  const artifact = join(s.root, "backup");
  let up = false;
  try {
    const started = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = started.status === 0;
    check("control: the open stack starts", up, s.shown(started));
    const nc = await connect({ servers: server });
    const jsm = await jetstreamManager(nc);
    // The settings a stream from before the limit carries.
    const { config } = await jsm.streams.info(chatStream(space));
    await jsm.streams.update(chatStream(space), { ...config, max_age: 0, max_msgs_per_subject: LEGACY_CHAT_HISTORY.perSender });
    await jetstream(nc).publish(`cotal.${space}.chat.o.a.general`, JSON.stringify({ kept: true }));
    await nc.close();
    const preserved = s.run("down", "--preserve-state");
    up = preserved.status !== 0;
    const backed = s.run("backup", "create", artifact);
    check("control: the backup is taken", preserved.status === 0 && backed.status === 0, { down: s.shown(preserved), backup: s.shown(backed) });
    const restored = s.run("up", "--restore", artifact, "--detach", "--server", server, "--space", space);
    up = restored.status === 0;
    check("control: the restore succeeds", up, s.shown(restored));
    const rc = await connect({ servers: server });
    const after = await (await jetstreamManager(rc)).streams.info(chatStream(space));
    await rc.close();
    check("a backup on the old settings restores on them", same(limitOf(after.config), LEGACY_CHAT_HISTORY) && after.state.messages === 1, { limit: limitOf(after.config), messages: after.state.messages });

    const stopped = s.run("down");
    up = stopped.status !== 0;
    const next = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = next.status === 0;
    const mc = await connect({ servers: server });
    const migrated = await (await jetstreamManager(mc)).streams.info(chatStream(space));
    await mc.close();
    check("the next start moves it to 30 days and 1000 per sender", next.status === 0 && same(limitOf(migrated.config), CHAT_HISTORY_DEFAULT), { up: s.shown(next), limit: limitOf(migrated.config) });
    check("...and says so", `${next.stdout}${next.stderr}`.includes("the broker now deletes posts older than 30d"), s.shown(next));
    check("...keeping the post that is newer than 30 days", migrated.state.messages === 1, migrated.state.messages);
  } catch (e) {
    check(`the legacy scenario ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
  } finally {
    if (up) s.run("down");
    s.cleanup();
  }
}

// ── a resume moves nothing ─────────────────────────────────────────────────────────────────────────
{
  const s = sandbox("resume");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "chl_resume";
  let up = false;
  try {
    const started = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = started.status === 0;
    check("control: the open stack starts", up, s.shown(started));
    const nc = await connect({ servers: server });
    const jsm = await jetstreamManager(nc);
    const { config } = await jsm.streams.info(chatStream(space));
    await jsm.streams.update(chatStream(space), { ...config, max_age: 0, max_msgs_per_subject: LEGACY_CHAT_HISTORY.perSender });
    await nc.close();

    const preserved = s.run("down", "--preserve-state");
    up = preserved.status !== 0;
    const resumed = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = resumed.status === 0;
    const c = await connect({ servers: server });
    const limit = limitOf((await (await jetstreamManager(c)).streams.info(chatStream(space))).config);
    await c.close();
    check("a resume after down --preserve-state runs no stream setup, so the old settings stay", up && !`${resumed.stdout}${resumed.stderr}`.includes("the broker now deletes posts older than 30d") && same(limit, LEGACY_CHAT_HISTORY), { down: s.shown(preserved), up: s.shown(resumed), limit });
  } catch (e) {
    check(`the resume scenario ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
  } finally {
    if (up) s.run("down");
    s.cleanup();
  }
}

// ── a start that fails after the move, from `cotal up` and from `cotal setup` ──────────────────────
// A prepared root starts on the controller-owned stack, the start that has a JSON receipt.
{
  const s = sandbox("late");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "chl_late";
  const seed = { channels: { general: { replay: true } } };
  const seedFile = join(s.root, "seed.json");
  writeFileSync(seedFile, JSON.stringify(seed));
  const notice = "the broker now deletes posts older than 30d";
  type Envelope = {
    error?: { code?: string; message?: string };
    warnings?: { code?: string; message?: string }[];
    changed?: { kind?: string; stream?: string; to?: ChatHistoryLimit }[];
    result?: { startup?: { state?: string; stack?: unknown; failure?: { code?: string; message?: string } } };
  };
  const envelopeOf = (r: SpawnSyncReturns<string>): Envelope | undefined => { try { return JSON.parse(r.stdout) as Envelope; } catch { return undefined; } };
  const namesMove = (e: Envelope | undefined) => e?.changed?.some((c) => c.kind === "chat-history-limit" && c.stream === chatStream(space) && c.to !== undefined && same(c.to, CHAT_HISTORY_DEFAULT)) === true;
  const chatLimit = async () => {
    const c = await connect({ servers: server });
    try { return limitOf((await (await jetstreamManager(c)).streams.info(chatStream(space))).config); } finally { await c.close(); }
  };
  const toLegacy = async () => {
    const c = await connect({ servers: server });
    try {
      const jsm = await jetstreamManager(c);
      const { config } = await jsm.streams.info(chatStream(space));
      await jsm.streams.update(chatStream(space), { ...config, max_age: 0, max_msgs_per_subject: LEGACY_CHAT_HISTORY.perSender });
    } finally { await c.close(); }
  };
  const start = (...extra: string[]) => s.run("up", "--space", space, "--open", "--no-manager", "--server", server, ...extra, "--json");
  const stop = () => s.run("down", "--yes");
  // Setup prepares this connector, and its launch throws, so setup stops once its start returns.
  const connector = join(s.home, "connector.mjs");
  writeFileSync(connector, `import { registry } from ${JSON.stringify(pathToFileURL(join(worktree, "packages/core/dist/index.js")).href)};\nregistry.register({ kind: "connector", name: "chl-smoke", requires: [], buildLaunch() { throw new Error("unexpected harness launch"); } });\n`);
  const setup = (...hooks: string[]) => s.runWith({ NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} ${[connector, ...hooks].map((hook) => `--import=${pathToFileURL(hook).href}`).join(" ")}` }, "setup", "--destination", "local", "--harness", "chl-smoke", "--project", s.root, "--space", space, "--start", "--detach", "--yes", "--json");
  const defaultChannels = join(s.root, ".cotal", "channels.json");
  try {
    const created = s.run("space", "create", space, "--root", s.root, "--json");
    check("control: the root is prepared", created.status === 0, s.shown(created));
    const started = start();
    check("control: the controller-owned stack starts", started.status === 0, s.shown(started));
    await toLegacy();
    const nc = await connect({ servers: server });
    // A registry entry that does not decode, which a seed for that channel refuses to write over.
    await jetstream(nc).publish(`$KV.${channelBucket(space)}.general`, "{not json");
    await nc.close();
    const stopped = stop();
    check("control: the stack stops", stopped.status === 0, s.shown(stopped));

    const failed = start("--channels", seedFile);
    const refusal = envelopeOf(failed);
    check("a start that moves the limit and then fails on a later step says the limit moved", failed.status !== 0 && refusal?.error?.code === "CONFLICT" && refusal.error.message?.includes(notice) === true, s.shown(failed));
    check("...and its envelope names the chat stream as changed", namesMove(refusal), refusal?.changed);

    const retry = start();
    check("the next start runs on the moved limit and reports no move", retry.status === 0 && !`${retry.stdout}${retry.stderr}`.includes(notice) && same(await chatLimit(), CHAT_HISTORY_DEFAULT), s.shown(retry));

    // Setup's start is a bare `cotal up`, which seeds the root's own channels file.
    await toLegacy();
    writeFileSync(defaultChannels, JSON.stringify(seed));
    const stoppedAgain = stop();
    check("control: the stack stops again", stoppedAgain.status === 0, s.shown(stoppedAgain));
    const setupFailed = setup();
    const setupRefusal = envelopeOf(setupFailed);
    check("a setup whose start moves the limit and then fails says the limit moved", setupFailed.status !== 0 && setupRefusal?.result?.startup?.state === "refused" && setupRefusal.result.startup.failure?.code === "CONFLICT" && setupRefusal.result.startup.failure.message?.includes(notice) === true, s.shown(setupFailed));
    check("...and setup's envelope names the chat stream as changed", namesMove(setupRefusal), setupRefusal?.changed);

    rmSync(defaultChannels);
    const restarted = start();
    check("control: the stack starts after the setup refusal", restarted.status === 0 && same(await chatLimit(), CHAT_HISTORY_DEFAULT), s.shown(restarted));
    await toLegacy();
    const stoppedLast = stop();
    check("control: the stack stops before the setup that goes on", stoppedLast.status === 0, s.shown(stoppedLast));
    const setupStarted = setup();
    const report = envelopeOf(setupStarted);
    check("control: setup's start returns and its launch fails after it", report?.result?.startup?.stack != null && same(await chatLimit(), CHAT_HISTORY_DEFAULT), s.shown(setupStarted));
    check("a setup whose start moves the limit and goes on warns that the limit moved", report?.warnings?.some((w) => w.code === "CHAT_HISTORY_MIGRATED" && w.message?.includes(notice) === true) === true, report?.warnings);
    check("...and names the chat stream as changed", namesMove(report), report?.changed);

    // A manager identity that does not read once the start returns. The hook spoils the file as the
    // startup child exits and puts it back as setup exits, so the stack still stops afterwards.
    const spoil = join(s.home, "spoil-identity.mjs");
    writeFileSync(spoil, `import { copyFileSync, existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.cwd(), ".cotal");
const records = () => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name, "manager-instance.json")).filter((f) => existsSync(f));
if (process.argv[2] === "__setup-start") process.on("exit", () => { for (const f of records()) { copyFileSync(f, f + ".kept"); writeFileSync(f, "{"); } });
if (process.argv[2] === "setup") process.on("exit", () => { for (const f of records()) if (existsSync(f + ".kept")) renameSync(f + ".kept", f); });
`);
    await toLegacy();
    const stoppedSpoiled = stop();
    check("control: the stack stops before the spoiled setup", stoppedSpoiled.status === 0, s.shown(stoppedSpoiled));
    const setupSpoiled = setup(spoil);
    const spoiled = envelopeOf(setupSpoiled);
    check("control: setup's start returns and its manager identity then does not read", spoiled?.result?.startup?.state === "unknown" && spoiled.result.startup.stack == null && same(await chatLimit(), CHAT_HISTORY_DEFAULT), s.shown(setupSpoiled));
    check("a setup whose manager identity does not read after the move says the limit moved", spoiled?.result?.startup?.failure?.message?.includes(notice) === true, spoiled?.result?.startup?.failure);
    check("...and that envelope names the chat stream as changed", namesMove(spoiled), spoiled?.changed);
  } catch (e) {
    check(`the late-failure scenario ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
  } finally {
    if (existsSync(join(s.root, ".cotal", "stack-controller.json"))) stop();
    s.cleanup();
  }
}

finish();
// A scenario that threw can leave a client connection retrying a broker that is gone.
process.exit(process.exitCode ?? 0);
