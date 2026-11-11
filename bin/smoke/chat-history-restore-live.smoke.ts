/**
 * The history limits across `cotal up` and backup and restore, on a real stack.
 *
 * A new space starts with no age limit and 1000 per sender. An existing space on those settings
 * keeps its posts older than 30 days through a `cotal up` that starts its broker, as an upgrade
 * does. The broker dates a post by its own clock, so the suite backdates the posts in the stopped
 * broker's store (`backdateMessages`). A restore holds CHAT, INBOX, DLV and DM at no age while it
 * checks the restored state, then sets the ages the backup recorded, one stream at a time; a
 * failure applying a later one rolls the whole attempt back. A backup on the old settings restores
 * on them and keeps them at the next start.
 *
 * The recorded-age scenario waits out the two-minute minimum age between the backup and the
 * restore, so its posts and DMs are older than the recorded ages when the restore checks them. A
 * restore that applied an age before those checks would watch the broker delete them and refuse. The last
 * scenario runs `cotal setup --start`, whose start happens in a child process, and checks that a
 * manager identity that does not read after the start is reported as an unknown outcome.
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
import { chatStream, dinboxSubject, dlvStream, dlvSubject, dmStream, historyLimitStreamName, inboxStream, mintLifecycleUid, type HistoryLimit, type HistoryLimitStream } from "@cotal-ai/core";
import { assertSmokeSandboxDown, backdateMessages, createSuite, freePort, recordSmokeSandbox, streamMsgsDir } from "@cotal-ai/smoke-kit";
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
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
  const runWith = (extra: Record<string, string>, ...args: string[]): SpawnSyncReturns<string> => {
    const options = { cwd: root, env: { ...env, ...extra }, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(anchor, args, options);
    return spawnSync(tsx, [cliPath, ...args], options);
  };
  const run = (...args: string[]) => runWith({}, ...args);
  const shown = (r: SpawnSyncReturns<string>) => ({ status: r.status, stdout: r.stdout?.slice(-1500), stderr: r.stderr?.slice(-1500) });
  return { root, home, run, runWith, shown, cleanup: () => { for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true }); } };
}

const limitOf = (config: { max_age?: number; max_msgs_per_subject?: number }): HistoryLimit => ({ maxAgeMs: (config.max_age ?? 0) / 1_000_000, perSubject: config.max_msgs_per_subject ?? Number.NaN });
const same = (a: HistoryLimit | undefined, b: HistoryLimit) => a !== undefined && a.maxAgeMs === b.maxAgeMs && a.perSubject === b.perSubject;
const HOUR = 60 * MIN;
const STREAMS: readonly HistoryLimitStream[] = ["chat", "inbox", "dlv", "dm"];

// The login that sets an age reaches its one stream alone.
for (const stream of ["CHAT_x", "DM_x"]) {
  const permissions = infrastructureMaintenancePermissions("conn", [stream], [stream]) as { pub: { allow: string[] } };
  const updates = permissions.pub.allow.filter((subject) => subject.startsWith("$JS.API.STREAM.UPDATE."));
  check(`the restore's age login for ${stream} may update it and no other stream`, updates.length === 1 && updates[0] === `$JS.API.STREAM.UPDATE.${stream}` && !permissions.pub.allow.some((subject) => subject.includes("OBJ_")), permissions.pub.allow);
}

// ── the recorded ages land after the restore's checks ──────────────────────────────────────────────
{
  const s = sandbox("age");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "chl_restore_age";
  const artifact = join(s.root, "backup");
  // INBOX and DLV on different limits, as a change that stopped partway leaves them, and DLV with
  // no count.
  const recorded: Record<HistoryLimitStream, HistoryLimit> = {
    chat: { maxAgeMs: 2 * MIN, perSubject: 2500 },
    inbox: { maxAgeMs: 2 * HOUR, perSubject: 1500 },
    dlv: { maxAgeMs: 3 * HOUR, perSubject: -1 },
    dm: { maxAgeMs: 2 * MIN, perSubject: 3 },
  };
  let up = false;
  try {
    const started = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = started.status === 0;
    check("control: the open stack starts", up, s.shown(started));
    const nc = await connect({ servers: server });
    const js = jetstream(nc);
    for (const i of [1, 2, 3]) await js.publish(`cotal.${space}.chat.o.a.general`, JSON.stringify({ i }));
    for (const i of [1, 2]) await js.publish(`cotal.${space}.inst.o.b.o.a`, JSON.stringify({ dm: i }));
    // Delivery copies, backdated below to just short of the two- and three-hour ages their streams
    // record: younger than the age when the backup reads them, older when the restore checks them.
    const uid = mintLifecycleUid();
    const copySeqs = { inbox: [] as number[], dlv: [] as number[] };
    for (const i of [1, 2]) copySeqs.inbox.push((await js.publish(dinboxSubject(space, "o", "a", uid), JSON.stringify({ copy: i }))).seq);
    for (const i of [1, 2]) copySeqs.dlv.push((await js.publish(dlvSubject(space, "o", "a", uid), JSON.stringify({ copy: i }))).seq);
    const writtenAt = Date.now();
    const set = s.run("history", "limit", "--max-age", "2m", "--per-sender", "2500", "--inbox-max-age", "2h", "--inbox-per-agent", "1500", "--dm-max-age", "2m", "--dm-per-sender", "3", "--yes", "--json", "--space", space);
    const njsm = await jetstreamManager(nc);
    const dlv = (await njsm.streams.info(dlvStream(space))).config;
    await njsm.streams.update(dlvStream(space), { ...dlv, max_age: nanos(recorded.dlv.maxAgeMs), max_msgs_per_subject: recorded.dlv.perSubject });
    await nc.close();
    check("control: the source takes an age and a count on each of the four streams", set.status === 0, s.shown(set));
    const preserved = s.run("down", "--preserve-state");
    up = preserved.status !== 0;
    const store = join(s.root, ".cotal", "nats");
    const SHORT_MS = 75_000;
    const backdatedAt = Date.now();
    const backdated = ([["inbox", copySeqs.inbox], ["dlv", copySeqs.dlv]] as const).map(([kind, seqs]) => {
      const stream = historyLimitStreamName(space, kind);
      return backdateMessages(streamMsgsDir(store, stream), stream, new Map(seqs.map((seq) => [seq, recorded[kind].maxAgeMs - SHORT_MS])), backdatedAt).join();
    });
    check("control: the stopped store's INBOX and DLV copies are backdated to 75 seconds short of their recorded ages", backdated[0] === copySeqs.inbox.join() && backdated[1] === copySeqs.dlv.join(), { backdated, copySeqs });
    const backed = s.run("backup", "create", artifact);
    check("control: the backup is taken", preserved.status === 0 && backed.status === 0, { down: s.shown(preserved), backup: s.shown(backed) });
    const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")) as { streams: { stream: string; config: { max_age?: number; max_msgs_per_subject?: number }; state: { messages: number } }[] };
    const recordedIn = (stream: HistoryLimitStream) => manifest.streams.find((row) => row.stream === historyLimitStreamName(space, stream));
    check("the backup records each stream's limit", STREAMS.every((stream) => { const row = recordedIn(stream); return row !== undefined && same(limitOf(row.config), recorded[stream]); }), STREAMS.map((stream) => recordedIn(stream)?.config));
    check("...and holds the backdated copies, taken before they reached their ages", recordedIn("inbox")?.state.messages === 2 && recordedIn("dlv")?.state.messages === 2, { inbox: recordedIn("inbox")?.state, dlv: recordedIn("dlv")?.state });

    const due = Math.max(writtenAt + 2 * MIN, backdatedAt + SHORT_MS) + 5_000 - Date.now();
    if (due > 0) await wait(due);
    // The age applied last in the manifest's order fails, after the ones before it landed.
    const ordered = manifest.streams.map((row) => row.stream).filter((name) => STREAMS.some((stream) => historyLimitStreamName(space, stream) === name));
    const lastAged = ordered[ordered.length - 1]!;
    const faulted = s.runWith({ COTAL_SMOKE_FAIL_RESTORE_STREAM: `age:${lastAged}` }, "up", "--restore", artifact, "--detach", "--server", server, "--space", space);
    check(`a failure applying a later age (${lastAged}) fails the restore with it`, faulted.status !== 0 && faulted.stderr.includes(`smoke-injected failure applying the recorded age of ${lastAged}`), s.shown(faulted));
    const restored = s.run("up", "--restore", artifact, "--detach", "--server", server, "--space", space);
    up = restored.status === 0;
    check("...and leaves the preserved cut ready, so the same restore runs again and passes its checks over posts, DMs and copies older than the recorded ages", restored.status === 0, s.shown(restored));
    const rc = await connect({ servers: server });
    const jsm = await jetstreamManager(rc);
    const held = Object.fromEntries(await Promise.all(STREAMS.map(async (stream) => [stream, limitOf((await jsm.streams.info(historyLimitStreamName(space, stream))).config)] as const))) as Record<HistoryLimitStream, HistoryLimit>;
    check("...then holds the recorded age and count on each stream, INBOX and DLV apart and DLV with no count", STREAMS.every((stream) => same(held[stream], recorded[stream])), held);
    const counts = async () => Promise.all([chatStream(space), dmStream(space), inboxStream(space), dlvStream(space)].map(async (name) => (await jsm.streams.info(name)).state.messages));
    let left = await counts();
    for (let i = 0; i < 50 && left.some((n) => n !== 0); i++) { await wait(200); left = await counts(); }
    check("...and the broker deletes the posts, DMs and INBOX and DLV copies older than their ages", left.every((n) => n === 0), { chat: left[0], dm: left[1], inbox: left[2], dlv: left[3] });
    const inbox = (await jsm.streams.info(inboxStream(space))).config;
    check("control: the inbox keeps its own two-hour age", inbox.max_age === nanos(2 * HOUR), inbox.max_age);
    await rc.close();
  } catch (e) {
    // A throw ends the scenario, not the suite, so the next one still runs and the summary prints.
    check(`the recorded-age scenario ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
  } finally {
    if (up) s.run("down", "--yes");
    s.cleanup();
  }
}


// ── an existing space keeps posts older than 30 days through cotal up ──────────────────────────────
{
  const s = sandbox("aged");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "chl_aged";
  const stream = chatStream(space);
  const DAY = 24 * 60 * MIN;
  const ages = [90, 45, 31, 1];
  let up = false;
  try {
    const started = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = started.status === 0;
    check("control: the open stack starts", up, s.shown(started));
    const nc = await connect({ servers: server });
    const njsm = await jetstreamManager(nc);
    const created = (await njsm.streams.info(stream)).config;
    // The literal pair, not the exported default, so a default that drifts to an age is caught here.
    check("a new space starts with no age limit and 1000 per sender", created.max_age === 0 && created.max_msgs_per_subject === 1000, limitOf(created));
    // The suite puts the stream on the old settings itself, so the cells after the next up test what that
    // up does to an existing stream on them, whatever this first up did.
    const seeded = (await njsm.streams.update(stream, { max_age: 0, max_msgs_per_subject: 1000 })).config;
    check("control: the stream is on the old settings, no age and 1000 per sender, before the next up", seeded.max_age === 0 && seeded.max_msgs_per_subject === 1000, limitOf(seeded));
    const js = jetstream(nc);
    const posts = ["general", "general", "ops", "ops"].map((channel, i) => ({ subject: `cotal.${space}.chat.o.a.${channel}`, data: JSON.stringify({ post: i + 1 }) }));
    const seqs: number[] = [];
    for (const post of posts) seqs.push((await js.publish(post.subject, post.data)).seq);
    await nc.close();
    // A full stop, so the next up starts the broker and runs stream setup, as an upgrade does.
    const stopped = s.run("down", "--yes");
    up = stopped.status !== 0;
    check("control: the stack stops", stopped.status === 0, s.shown(stopped));
    const rewrote = backdateMessages(streamMsgsDir(join(s.root, ".cotal", "nats"), stream), stream, new Map(seqs.map((seq, i) => [seq, ages[i]! * DAY])));
    check("control: the stopped store's four posts are backdated 90, 45, 31 and 1 days", rewrote.join() === seqs.join(), { rewrote, seqs });

    const next = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = next.status === 0;
    check("control: the stack starts again", up, s.shown(next));
    const mc = await connect({ servers: server });
    const jsm = await jetstreamManager(mc);
    const info = await jsm.streams.info(stream);
    // A post the broker deleted reads as null, so the cell below names what is missing.
    const held = await Promise.all(seqs.map((seq) => jsm.direct.getMessage(stream, { seq }).then((m) => m && { subject: m.subject, data: m.string(), days: Math.round((Date.now() - m.time.getTime()) / DAY) }, () => null)));
    await mc.close();
    const intact = held.every((m, i) => m !== null && m.subject === posts[i]!.subject && m.data === posts[i]!.data && m.days === ages[i]);
    check("an existing space keeps every post older than 30 days through cotal up", intact, { messages: info.state.messages, held });
    check("...on the limit it had: no age and 1000 per sender", info.config.max_age === 0 && info.config.max_msgs_per_subject === 1000, limitOf(info.config));
    check("...and up says nothing about the history limit", !/history limit|deletes posts/.test(`${next.stdout}${next.stderr}`), s.shown(next));
  } catch (e) {
    check(`the aged-posts scenario ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
  } finally {
    if (up) s.run("down", "--yes");
    s.cleanup();
  }
}

// ── a backup on the old settings ───────────────────────────────────────────────────────────────────
{
  const s = sandbox("old");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "chl_restore_old";
  const artifact = join(s.root, "backup");
  const old = { maxAgeMs: 0, perSubject: 1000 };
  let up = false;
  try {
    const started = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = started.status === 0;
    check("control: the open stack starts", up, s.shown(started));
    const nc = await connect({ servers: server });
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
    const rjsm = await jetstreamManager(rc);
    const after = await rjsm.streams.info(chatStream(space));
    const others = await Promise.all([inboxStream(space), dlvStream(space), dmStream(space)].map(async (name) => limitOf((await rjsm.streams.info(name)).config)));
    await rc.close();
    check("a backup on the old settings, no age and 1000 per sender, restores on them", same(limitOf(after.config), old) && after.state.messages === 1, { limit: limitOf(after.config), messages: after.state.messages });
    check("...with INBOX and DLV at 1000 per agent and DM with no count, as every space before their limits were configurable", same(others[0], { maxAgeMs: 0, perSubject: 1000 }) && same(others[1], { maxAgeMs: 0, perSubject: 1000 }) && same(others[2], { maxAgeMs: 0, perSubject: -1 }), others);

    const stopped = s.run("down", "--yes");
    up = stopped.status !== 0;
    const next = s.run("up", "--detach", "--open", "--server", server, "--space", space);
    up = next.status === 0;
    const mc = await connect({ servers: server });
    const kept = await (await jetstreamManager(mc)).streams.info(chatStream(space));
    await mc.close();
    check("the next start that starts its broker keeps them, and the post", next.status === 0 && same(limitOf(kept.config), old) && kept.state.messages === 1, { up: s.shown(next), limit: limitOf(kept.config), messages: kept.state.messages });
  } catch (e) {
    check(`the old-settings backup scenario ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
  } finally {
    if (up) s.run("down", "--yes");
    s.cleanup();
  }
}

// ── setup's start, when the manager identity does not read afterwards ──────────────────────────────
// A prepared root starts on the controller-owned stack, the start that has a JSON receipt.
{
  const s = sandbox("setup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "chl_setup";
  type Envelope = { result?: { startup?: { state?: string; stack?: unknown; failure?: { code?: string; message?: string } } } };
  const envelopeOf = (r: SpawnSyncReturns<string>): Envelope | undefined => { try { return JSON.parse(r.stdout) as Envelope; } catch { return undefined; } };
  const start = () => s.run("up", "--space", space, "--open", "--no-manager", "--server", server, "--json");
  const stop = () => s.run("down", "--yes");
  // Setup prepares this connector, and its launch throws, so setup stops once its start returns.
  const connector = join(s.home, "connector.mjs");
  writeFileSync(connector, `import { registry } from ${JSON.stringify(pathToFileURL(join(worktree, "packages/core/dist/index.js")).href)};\nregistry.register({ kind: "connector", name: "chl-smoke", requires: [], buildLaunch() { throw new Error("unexpected harness launch"); } });\n`);
  // The hook spoils the manager identity as the startup child exits and puts it back as setup
  // exits, so the stack still stops afterwards.
  const spoil = join(s.home, "spoil-identity.mjs");
  writeFileSync(spoil, `import { copyFileSync, existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.cwd(), ".cotal");
const records = () => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name, "manager-instance.json")).filter((f) => existsSync(f));
if (process.argv[2] === "__setup-start") process.on("exit", () => { for (const f of records()) { copyFileSync(f, f + ".kept"); writeFileSync(f, "{"); } });
if (process.argv[2] === "setup") process.on("exit", () => { for (const f of records()) if (existsSync(f + ".kept")) renameSync(f + ".kept", f); });
`);
  const setup = () => s.runWith({ NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} ${[connector, spoil].map((hook) => `--import=${pathToFileURL(hook).href}`).join(" ")}` }, "setup", "--destination", "local", "--harness", "chl-smoke", "--project", s.root, "--space", space, "--start", "--detach", "--yes", "--json");
  try {
    const created = s.run("space", "create", space, "--root", s.root, "--json");
    check("control: the root is prepared", created.status === 0, s.shown(created));
    const started = start();
    check("control: the controller-owned stack starts", started.status === 0, s.shown(started));
    const stopped = stop();
    check("control: the stack stops before setup", stopped.status === 0, s.shown(stopped));
    const spoiled = envelopeOf(setup());
    check("a setup whose manager identity does not read after its start reports an unknown outcome with that reason", spoiled?.result?.startup?.state === "unknown" && spoiled.result.startup.stack == null && spoiled.result.startup.failure?.message?.includes("manager instance identity does not read") === true, spoiled?.result?.startup);
  } catch (e) {
    check(`the setup scenario ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
  } finally {
    if (existsSync(join(s.root, ".cotal", "stack-controller.json"))) stop();
    s.cleanup();
  }
}

finish();
// A scenario that threw can leave a client connection retrying a broker that is gone.
process.exit(process.exitCode ?? 0);
