/**
 * LIVE e2e for `channel members` on a running static-auth stack, whose delivery service writes the
 * membership feed. Two `join` sessions hold live subscriptions: one to the registered #general and one
 * to #lounge, which has no saved entry and no retained message. #archive has a retained message and no
 * member. Then:
 *
 *  A. a name the space does not have, and `General` for the registered #general, are refused
 *     `TARGET_NOT_FOUND` with no census, naming the registered channels or the registered spelling.
 *     #lounge lists its member, #archive reads as an empty channel, and #general lists its member
 *     with a Next to follow it.
 *  B. `--follow --json` across two feed polls that change nothing writes its snapshot and no event,
 *     and a member who joins then is an event. No two records in a row show the same census, and the
 *     end record carries the last poll the follow read. The plain follow offers no command to follow.
 *  C. an agent that follows the family team.> on a provisioned credential (a bare join holds no
 *     durable membership) is a durable member of the durable #team.build and a live-only one of the
 *     live #team.chat. Once it stops, it stays on #team.build as a member with stored copies and
 *     leaves #team.chat. A follow of #team.build drops it once only the channel's class turns live.
 *
 * COTAL_HOME is sandboxed, the child environment carries no `COTAL_` variable of the runner, and the
 * stack stops with `cotal down --yes`. Needs `nats-server` on PATH. Run: pnpm smoke:channel-members:live
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, recordSmokeSandbox, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { dialerFor, drainAndClose, isReachable, membershipStoreDefinition, mintCreds, newIdentity, standaloneConnectOpts } from "@cotal-ai/core";
import { getSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager, StorageType } from "@nats-io/jetstream";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const SERVER = `nats://127.0.0.1:${await freePort()}`;
const SPACE = `channel-members-${process.pid}`;
const base = mkdtempSync(join(tmpdir(), "cotal-channel-members-"));
const home = join(base, "home"), configDir = join(base, "xdg"), s = join(base, "s");
// The product refuses a local-record store that is not private, so every folder here is 0700.
for (const dir of [home, configDir, s]) mkdirSync(dir, { mode: 0o700 });
const sandbox = recordSmokeSandbox({ root: s, cotalHome: home, xdgConfigHome: configDir });
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_") && key !== "FORCE_COLOR") env[key] = value;
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" });

const { check, finish } = createSuite();
const cotal = (...args: string[]) => {
  const options = { cwd: s, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  const run = spawnSync(TSX, [CLI, ...args], options);
  return { status: run.status, stdout: run.stdout, out: `${run.stdout}${run.stderr}` };
};
type Census = { asOf: number | null; members: { id: string; name: string | null; live: boolean; durable: boolean }[] };
type Envelope = { outcome?: string; error?: { code?: string; message?: string; remedy?: string }; result?: Census };
type StreamRecord = { type: string; data: Census & { lastAsOf?: number | null } };
const envelope = (stdout: string): Envelope | undefined => { try { return JSON.parse(stdout) as Envelope; } catch { return undefined; } };
const census = (channel: string) => envelope(cotal("channel", "members", channel, "--json").stdout)?.result;
const named = (result: Census | undefined, name: string) => result?.members.some((member) => member.name === name) ?? false;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const until = async (test: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(1_000)) if (test()) return true;
  return false;
};

interface Started { child: ChildProcess; out: string; exited: Promise<unknown> }
const running: Started[] = [];
/** A long-running command on pipes, with what it has written so far. Its stdin stays open. */
const started = (...args: string[]): Started => {
  const child = spawn(TSX, [CLI, ...args], { cwd: s, env, stdio: ["pipe", "pipe", "pipe"] });
  const run: Started = { child, out: "", exited: new Promise((done) => child.on("close", done)) };
  child.stdout.on("data", (chunk: Buffer) => { run.out += chunk; });
  child.stderr.on("data", (chunk: Buffer) => { run.out += chunk; });
  running.push(run);
  return run;
};
const records = (out: string) => out.split("\n").filter((line) => line.startsWith('{"schemaVersion"')).map((line) => JSON.parse(line) as StreamRecord);
/** What a change is: whether the feed has a census, and who it observed how. */
const shape = (data: Census) => JSON.stringify([data.asOf !== null, data.members.map(({ id, name, live, durable }) => [id, name, live, durable])]);

let up = false;
try {
  check("space create prepares the folder", cotal("space", "create", SPACE).status === 0);
  up = true;
  const stack = cotal("up", "--server", SERVER, "--no-manager");
  check("up starts the static-auth stack", stack.status === 0, stack.out.slice(-600));
  if (stack.status !== 0) throw new Error("the stack did not start; no later cell can run");
  check("#general is registered", cotal("channel", "set", "general", "--desc", "General talk").status === 0);
  check("#archive has a retained message and no saved entry", cotal("send", "-c", "archive", "kept").status === 0);
  started("join", "--name", "anna", "--channel", "general");
  started("join", "--name", "bert", "--channel", "lounge");
  const seen = await until(() => named(census("general"), "anna") && named(census("lounge"), "bert"), 90_000);
  check("the feed observes anna on #general and bert on #lounge", seen);

  console.log("\nA. a name the space does not have");
  const unknown = cotal("channel", "members", "nosuch", "--json");
  const refusal = envelope(unknown.stdout);
  check("an unknown name is refused TARGET_NOT_FOUND, exit 2, naming the registered channels",
    unknown.status === 2 && refusal?.outcome === "refused" && refusal.error?.code === "TARGET_NOT_FOUND"
      && refusal.error.message === "#nosuch has no observed members, no saved entry and no retained messages; registered channels: #general"
      && refusal.error.remedy === "name a channel the space has; `cotal ch` lists the registered ones", unknown.out.slice(-600));
  const cased = cotal("channel", "members", "General");
  check("General names the registered #general and the command for it, with no census",
    cased.status === 2 && cased.out.includes("channel names are case-sensitive, and the registered one is #general")
      && cased.out.includes("name it as registered: `cotal channel members general`") && !cased.out.includes("Members ·"), cased.out.slice(-600));
  const lounge = census("lounge");
  check("#lounge, with no saved entry and no message, still lists its member", lounge?.asOf !== null && named(lounge, "bert"), lounge);
  const archive = cotal("channel", "members", "archive");
  check("#archive, with a retained message and no member, reads as an empty channel, exit 0",
    archive.status === 0 && archive.out.includes("No members in this feed snapshot."), archive.out.slice(-600));
  const general = cotal("channel", "members", "general");
  check("#general lists anna and offers to follow it",
    general.status === 0 && general.out.includes("anna") && general.out.includes("cotal ch members general --follow"), general.out.slice(-600));

  console.log("\nB. a follow writes changes only");
  const followJson = started("channel", "members", "general", "--follow", "--json");
  const followPlain = started("channel", "members", "general", "--follow", "--plain");
  const opened = await until(() => records(followJson.out).some((r) => r.type === "snapshot") && /Members . #general/.test(followPlain.out), 60_000);
  check("both follows show the census", opened, { json: followJson.out.slice(-600), plain: followPlain.out.slice(-600) });
  const first = records(followJson.out).find((r) => r.type === "snapshot")?.data.asOf ?? 0;
  /** The feed's next poll after `asOf`, as a one-shot read sees it. */
  const pollAfter = async (asOf: number | undefined) => {
    let next = 0;
    return asOf !== undefined && await until(() => (next = census("general")?.asOf ?? 0) > asOf, 60_000) ? next : undefined;
  };
  const third = await pollAfter(await pollAfter(first));
  // The follow reads each poll a moment after the feed writes it.
  await wait(2_000);
  const quiet = records(followJson.out);
  check("two feed polls that change nothing write no event", third !== undefined && quiet.length === 1 && quiet[0]?.type === "snapshot", { third, types: quiet.map((r) => r.type) });
  check("the plain follow printed its census once", (followPlain.out.match(/Members . #general/g) ?? []).length === 1, followPlain.out.slice(-600));
  started("join", "--name", "carl", "--channel", "general");
  const joined = await until(() => records(followJson.out).some((r) => r.type === "event" && named(r.data, "carl")), 60_000);
  check("a member who joins is an event", joined, records(followJson.out).map((r) => r.type));
  for (const follow of [followJson, followPlain]) follow.child.kill("SIGINT");
  await Promise.all([followJson.exited, followPlain.exited]);
  const all = records(followJson.out);
  const shown = all.filter((r) => r.type === "snapshot" || r.type === "event").map((r) => shape(r.data));
  check("no two records in a row show the same census", shown.every((item, i) => i === 0 || item !== shown[i - 1]), shown);
  const end = all.at(-1);
  check("the end record carries the last poll the follow read", end?.type === "end" && (end.data.lastAsOf ?? 0) > first, { first, end });
  check("the plain follow shows carl and offers no command to follow",
    followPlain.out.includes("carl") && !followPlain.out.includes("cotal ch members general --follow"), followPlain.out.slice(-600));

  console.log("\nC. a family follower");
  check("#team.build is durable and #team.chat is live",
    cotal("channel", "set", "team.build", "--delivery", "durable").status === 0 && cotal("channel", "set", "team.chat", "--delivery", "live").status === 0);
  const fernCreds = join(base, "fern.creds");
  const minted = envelope(cotal("auth", "mint", "fern", "--provision", "--allow-subscribe", "team.>", "--allow-publish", "team.build", "--out", fernCreds, "--json").stdout) as
    { result?: { lifecycleUid?: string } } | undefined;
  const fernUid = minted?.result?.lifecycleUid ?? "";
  check("a provisioned credential for fern reads team.>", fernUid !== "", minted);
  const fern = started("join", "--creds", fernCreds, "--lifecycle-uid", fernUid, "--space", SPACE, "--name", "fern", "--channel", "team.>");
  const member = (channel: string) => census(channel)?.members.find((m) => m.name === "fern");
  const online = await until(() => member("team.build")?.durable === true && member("team.chat")?.live === true, 90_000);
  const build = member("team.build"), chat = member("team.chat");
  check("while connected, fern is a live and durable member of #team.build", online && build?.live === true && build.durable === true, build);
  check("while connected, fern is a live member of #team.chat with no stored copies", chat?.live === true && chat.durable === false, chat);
  const fernId = build?.id;
  const durableMember = (channel: string) => census(channel)?.members.find((m) => m.id === fernId);
  fern.child.kill("SIGINT");
  await fern.exited;
  const away = await until(() => durableMember("team.build")?.live === false && member("team.chat") === undefined, 90_000);
  check("once fern stops, #team.build still lists fern as a durable member", away && durableMember("team.build")?.durable === true, census("team.build"));
  check("once fern stops, #team.chat no longer lists fern", member("team.chat") === undefined, census("team.chat"));
  // Whether the family row counts turns on the channel's class, and no membership change says the
  // class moved: the follow notices it at a feed heartbeat.
  const holds = (data: Census | undefined) => data?.members.some((m) => m.id === fernId && m.durable) ?? false;
  const follow = started("channel", "members", "team.build", "--follow", "--json");
  const following = await until(() => records(follow.out).some((r) => r.type === "snapshot"), 60_000);
  check("a follow of #team.build opens listing the offline fern",
    following && fernId !== undefined && holds(records(follow.out).find((r) => r.type === "snapshot")?.data), follow.out.slice(-600));
  check("#team.build turns live", cotal("channel", "set", "team.build", "--delivery", "live").status === 0);
  const dropped = await until(() => records(follow.out).some((r) => r.type === "event" && !holds(r.data)), 60_000);
  check("the follow drops fern once #team.build turns live, with no membership change", dropped, records(follow.out).map((r) => r.type));
  follow.child.kill("SIGINT");
  await follow.exited;

  console.log("\nD. a stopped legacy membership feed converts without losing durable state");
  for (const run of running) if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGINT");
  await Promise.all(running.map((run) => run.exited));
  check("team.build is durable again before the upgrade", cotal("channel", "set", "team.build", "--delivery", "durable").status === 0);
  check("the old message is retained before conversion", cotal("history", "archive", "--json").stdout.includes("kept"));
  check("stop every stack member before preparing a legacy feed", cotal("down", "--yes").status === 0);
  const brokerConfig = join(base, `${SMOKE_BROKER_TOKEN}.conf`);
  copyFileSync(join(s, ".cotal", "auth", "server.conf"), brokerConfig);
  const brokerChild = spawn("nats-server", ["-c", brokerConfig], { cwd: s, env, stdio: "ignore" });
  const releaseBroker = teardownOnSignal(brokerChild);
  await awaitBrokerReady(() => isReachable(SERVER), { servers: SERVER, attempts: 50, delayMs: 100 });
  check("the fixture broker opens the stopped store without membership services", true);
  const auth = await getSpaceAuth(workspaceSecretStore(s), SPACE);
  if (!auth) throw new Error("fixture trust is missing");
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await dialerFor(SERVER)({ servers: SERVER, ...standaloneConnectOpts({ creds, tls: false }) });
  const bucket = membershipStoreDefinition(SPACE).bucket;
  let legacyCreated: string;
  try {
    await new Kvm(nc).create(bucket, { history: 1, storage: StorageType.File, max_bytes: 64 * 1024 * 1024 });
    legacyCreated = (await (await jetstreamManager(nc)).streams.info(`KV_${bucket}`)).created;
    const refused = cotal("up");
    check("an externally running broker is not converted or adopted", refused.status !== 0 && !refused.out.includes("Converted "), refused.out.slice(-800));
    check("the reused legacy stream was not replaced", (await (await jetstreamManager(nc)).streams.info(`KV_${bucket}`)).created === legacyCreated);
  } finally { await drainAndClose(nc); await killAndAwaitExit(brokerChild); releaseBroker(); }
  const converted = cotal("up", "--json");
  check("plain up converts the stopped legacy feed and reports it once", converted.status === 0 && (converted.out.match(/Converted /g) ?? []).length === 1, converted.out.slice(-900));
  check("structured conversion keeps stdout as one JSON envelope", envelope(converted.stdout)?.outcome === "ok", converted.stdout.slice(0, 700));
  if (converted.status !== 0) throw new Error("automatic membership conversion failed");
  const durableFern = () => census("team.build")?.members.some((row) => row.id === fernId && row.durable);
  check("durable fern membership rebuilds with a fresh heartbeat", await until(() => durableFern() === true && (census("team.build")?.asOf ?? 0) > 0, 90_000), census("team.build"));
  check("retained history survives conversion", cotal("history", "archive", "--json").stdout.includes("kept"));
  check("new messages still store after conversion", cotal("send", "-c", "archive", "after conversion").status === 0);
  const repeat = cotal("up");
  check("a running Memory feed is not converted again", repeat.status === 0 && !repeat.out.includes("Converted "), repeat.out.slice(-600));
  check("stop the Memory-backed stack", cotal("down", "--yes").status === 0);
  const restarted = cotal("up", "--recreate-membership-store");
  check("the accepted flag also starts a missing Memory feed without deletion", restarted.status === 0 && !restarted.out.includes("Converted "), restarted.out.slice(-600));
  const history = cotal("history", "archive", "--json");
  check("old and new history survive another broker restart", history.status === 0 && history.stdout.includes("kept") && history.stdout.includes("after conversion"), history.out.slice(-600));
} finally {
  for (const { child } of running) if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
  await Promise.all(running.map((run) => run.exited));
  if (up) {
    const down = cotal("down", "--yes");
    check("down --yes stops the stack", down.status === 0, down.out.slice(-600));
  }
  rmSync(base, { recursive: true, force: true });
}
finish();
// A child's handles can outlive the suite's own work; the verdict is already recorded.
process.exit();
