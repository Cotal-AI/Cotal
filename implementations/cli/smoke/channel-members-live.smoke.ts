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
 *
 * COTAL_HOME is sandboxed, the child environment carries no `COTAL_` variable of the runner, and the
 * stack stops with `cotal down --yes`. Needs `nats-server` on PATH. Run: pnpm smoke:channel-members:live
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

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
