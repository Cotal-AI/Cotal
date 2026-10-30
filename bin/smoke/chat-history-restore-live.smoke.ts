/**
 * Backup and restore of the chat stream's history limit, on a real stack: a restore holds the chat
 * stream at no age while it checks the restored state, then sets the age the backup recorded, and a
 * backup on the old settings restores on them and moves at the next start. A resume moves nothing,
 * and a start that fails after the move says so in its error.
 *
 * The first scenario waits out the two-minute minimum age between the backup and the restore, so
 * its posts are older than the recorded age when the restore checks them. A restore that applied
 * the age before those checks would watch the broker delete them and refuse.
 *
 * Run: pnpm smoke:chat-history-restore:live   (needs nats-server on PATH)
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
  const run = (...args: string[]): SpawnSyncReturns<string> => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(anchor, args, options);
    return spawnSync(tsx, [cliPath, ...args], options);
  };
  const shown = (r: SpawnSyncReturns<string>) => ({ status: r.status, stdout: r.stdout?.slice(-1500), stderr: r.stderr?.slice(-1500) });
  return { root, home, run, shown, cleanup: () => { for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true }); } };
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

// ── a resume, and a start that fails after the move ────────────────────────────────────────────────
{
  const s = sandbox("late");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "chl_late_failure";
  const seed = join(s.root, "seed.json");
  writeFileSync(seed, JSON.stringify({ channels: { general: { replay: true } } }));
  const moved = (r: SpawnSyncReturns<string>) => `${r.stdout}${r.stderr}`.includes("the broker now deletes posts older than 30d");
  const chatLimit = async () => {
    const c = await connect({ servers: server });
    try { return limitOf((await (await jetstreamManager(c)).streams.info(chatStream(space))).config); } finally { await c.close(); }
  };
  let up = false;
  try {
    const started = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = started.status === 0;
    check("control: the open stack starts", up, s.shown(started));
    const nc = await connect({ servers: server });
    const jsm = await jetstreamManager(nc);
    const { config } = await jsm.streams.info(chatStream(space));
    await jsm.streams.update(chatStream(space), { ...config, max_age: 0, max_msgs_per_subject: LEGACY_CHAT_HISTORY.perSender });
    // A registry entry that does not decode, which a seed for that channel refuses to write over.
    await jetstream(nc).publish(`$KV.${channelBucket(space)}.general`, "{not json");
    await nc.close();

    const preserved = s.run("down", "--preserve-state");
    up = preserved.status !== 0;
    const resumed = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = resumed.status === 0;
    check("a resume after down --preserve-state runs no stream setup, so the old settings stay", up && !moved(resumed) && same(await chatLimit(), LEGACY_CHAT_HISTORY), { down: s.shown(preserved), up: s.shown(resumed) });

    const stopped = s.run("down");
    up = stopped.status !== 0;
    const failed = s.run("up", "--detach", "--open", "--server", server, "--space", space, "--channels", seed, "--json");
    up = failed.status === 0;
    let envelope: { error?: { code?: string }; changed?: { kind?: string; stream?: string; to?: ChatHistoryLimit }[] } | undefined;
    try { envelope = JSON.parse(failed.stdout); } catch { envelope = undefined; }
    check("a start that moves the limit and then fails on a later step says the limit moved", failed.status !== 0 && envelope?.error?.code === "CONFLICT" && moved(failed), s.shown(failed));
    check("...and its envelope names the chat stream as changed", envelope?.changed?.some((c) => c.kind === "chat-history-limit" && c.stream === chatStream(space) && c.to !== undefined && same(c.to, CHAT_HISTORY_DEFAULT)) === true, envelope?.changed);

    const retry = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = retry.status === 0;
    check("the next start runs on the moved limit and reports no move", up && !moved(retry) && same(await chatLimit(), CHAT_HISTORY_DEFAULT), s.shown(retry));
  } catch (e) {
    check(`the late-failure scenario ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
  } finally {
    if (up) s.run("down");
    s.cleanup();
  }
}

finish();
// A scenario that threw can leave a client connection retrying a broker that is gone.
process.exit(process.exitCode ?? 0);
