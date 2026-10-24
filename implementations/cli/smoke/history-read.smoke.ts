/**
 * `cotal history [channel]` on the structured output contract, against brokers this suite owns. Real
 * agents post to channels and DM each other; the CLI child reads with its own one-shot credential.
 * Covers one channel and every channel, `--limit`, `--since` by sequence and by time, `--from` and
 * `--grep`, `--dms`, the usage refusals, a credential that may not read history, writes an observer
 * credential may not make, one another space's
 * account issued (also with `--server`, when that space is registered here at another address),
 * `--follow` as NDJSON
 * and as lines, and a retention gap (on an open broker, one sender posts past the chat stream's
 * per-sender limit). The user-auth result rendering is driven against a stand-in endpoint. On the
 * same broker, `cotal channel remove` says whether it removed a saved entry and refuses a name with
 * no saved entry and no retained messages, and on the open broker
 * `cotal channel members` refuses with `UNSUPPORTED`.
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
import { authDir, clearCurrent, recordMesh, removeMesh, saveSpaceAuth, setCurrent } from "@cotal-ai/workspace";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { clean, nodePty } from "./_console-pty.js";
import { credentialEnded } from "../src/lib/connect.js";

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
  window: { limit: number; read: number; olderRetained: boolean | null; since: string | null; reachesSince: boolean | null };
  retention: { perSender: number | null; gaps: { channel: string; name: string | null; retained: number }[] } | null;
  replay: { channel: string; replay: boolean | null }[];
  items: Item[];
};
type Envelope = { outcome: string; completeness: string; command: string; target: unknown; result: Result | null; warnings: { code: string; message: string }[]; error?: { code: string; message: string; remedy?: string } };

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
// Usage telemetry is off: in a fresh home on a terminal it would also print its one-time notice.
const isolatedEnv: NodeJS.ProcessEnv = { ...cleanEnv, HOME: home, USERPROFILE: home, TMPDIR: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };

const run = (args: string[], cwd = shell, extra: NodeJS.ProcessEnv = {}): Promise<{ status: number; stdout: string; stderr: string; envelope?: Envelope }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env: { ...isolatedEnv, ...extra }, timeout: 120_000 }, (err, stdout, stderr) => {
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
  // A bare number is a sequence, so a year reads as one; the report used to name no filter at all,
  // and a year past the newest sequence read as an empty window.
  const [seqPlain, yearJson] = await Promise.all([run(["history", "general", "--since", String(items[0]?.seq), "--plain"]), run(["history", "general", "--since", "2026", "--json"])]);
  check("a sequence --since is named in the report", seqPlain.stdout.includes(`--since ${items[0]?.seq} is chat stream sequence ${items[0]?.seq}; only messages after it are shown\n`), shown(seqPlain));
  check("a bare number past the newest sequence is refused USAGE_INVALID with that sequence and how to write a date",
    yearJson.status === 1 && /^--since 2026 is past the chat stream's newest sequence, \d+, so it names no message$/.test(yearJson.envelope?.error?.message ?? "") && /^give a sequence up to \d+, or write a date in full, such as 2026-01-01$/.test(yearJson.envelope?.error?.remedy ?? ""), shown(yearJson));
  const byTime = await run(["history", "general", "--since", midpoint, "--json"]);
  check("--since a time keeps only messages after it", JSON.stringify(texts(byTime)) === JSON.stringify(["deploy finished"]), texts(byTime));
  // A bare date is local midnight. ECMAScript reads it as UTC, so east of UTC it dropped the day's
  // first hours. Etc/GMT-14 is UTC+14.
  const east = { TZ: "Etc/GMT-14" };
  const [dayJson, dayPlain] = await Promise.all([run(["history", "general", "--since", "2026-01-15", "--json"], shell, east), run(["history", "general", "--since", "2026-01-15", "--plain"], shell, east)]);
  check("--since a bare date is local midnight, and the report names the instant it resolved to",
    dayJson.envelope?.result?.window.since === "2026-01-14T10:00:00.000Z" && dayPlain.stdout.includes("--since 2026-01-15 is ") && dayPlain.stdout.includes("local time (2026-01-14T10:00:00.000Z); only messages after it are shown"), { json: dayJson.envelope?.result?.window, plain: shown(dayPlain) });
  const narrow = await run(["history", "general", "--limit", "1", "--since", String(items[0]?.seq), "--json"]);
  check("a window that does not reach back to --since says so", narrow.envelope?.result?.window.reachesSince === false, narrow.envelope?.result?.window);
  const hashed = await run(["history", "#general", "--json"]);
  check("#general reads the same channel as general", JSON.stringify(texts(hashed)) === JSON.stringify(texts(general)) && hashed.envelope?.result?.channels[0] === "general", shown(hashed));
  // A channel the space lacks used to report the space's replay default as if it existed.
  const lacking = await run(["history", "nosuch", "--json"]);
  check("a channel with no messages and no saved entry warns CHANNEL_NOT_FOUND, shows no replay policy, and is still complete",
    lacking.status === 0 && lacking.envelope?.completeness === "complete" && lacking.envelope.warnings.some((w) => w.code === "CHANNEL_NOT_FOUND") && lacking.envelope.result?.replay.length === 0, shown(lacking));
  const fromBob = await run(["history", "--from", "bob", "--json"]);
  check("--from keeps one sender's messages", JSON.stringify(texts(fromBob)) === JSON.stringify(["looks good", "paging ops"]), texts(fromBob));
  const grep = await run(["history", "--grep", "DEPLOY", "--json"]);
  check("--grep matches text case-insensitively within the window", JSON.stringify(texts(grep)) === JSON.stringify(["deploy started", "deploy finished"]) && grep.envelope?.result?.window.read === 4, { texts: texts(grep), window: grep.envelope?.result?.window });

  const dms = await run(["history", "--dms", "--json"]);
  check("--dms adds DMs, each naming its recipient", dms.status === 0 && (dms.envelope?.result?.items ?? []).some((i) => i.text === "a private note" && i.channel === null && i.to === bobId), shown(dms));
  // A DM to a recipient that had sent nothing used to show its principal; the roster names it.
  const erin = await agent("erin");
  await alice.unicast(`${erin.principal.owner}.${erin.principal.actor}`, "for erin");
  await wait(600);
  const dmsPlain = await run(["history", "--dms", "--plain"]);
  check("a DM row names its recipient from the roster when the recipient has sent nothing",
    dmsPlain.status === 0 && /DM to erin\s+alice\s+for erin/.test(dmsPlain.stdout) && /DM to bob\s+alice\s+a private note/.test(dmsPlain.stdout), dmsPlain.stdout);

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
  // A value that starts with a dash used to be refused by the parser as "ambiguous", and a channel
  // with `*` or a leading `#` got the subject grammar's reason.
  const [negLimit, negSince, starred] = await Promise.all([["--limit", "-1"], ["--since", "-5"], ["gen*"]].map((args) => run(["history", ...args, "--server", unavailable, "--json"])));
  check("a negative --limit or --since gets the flag's own rule, before connecting",
    negLimit.status === 1 && negLimit.envelope?.error?.message === '--limit takes a whole number from 1 to 1000, not "-1"'
      && negSince.status === 1 && negSince.envelope?.error?.message === '--since takes a time (ISO 8601, or an age such as 30m, 2h, 1d) or a chat stream sequence, not "-5"', { negLimit: shown(negLimit), negSince: shown(negSince) });
  check("a channel holding * is refused with the wildcard sentence, before connecting",
    starred.status === 1 && starred.envelope?.error?.message === "name one concrete channel, without wildcards", shown(starred));
  const notADay = await run(["history", "--since", "2026-02-30", "--server", unavailable, "--json"]);
  check("a --since date that is not on the calendar is a usage error before connecting", notADay.status === 1 && notADay.envelope?.error?.message === "--since 2026-02-30 is not a calendar date", shown(notADay));
  const unsafeSequence = await run(["history", "--since", "9007199254740993", "--server", unavailable, "--json"]);
  check("an inexact --since sequence is a usage error before connecting", unsafeSequence.status === 1 && unsafeSequence.envelope?.error?.code === "USAGE_INVALID", shown(unsafeSequence));

  // ── a credential that may not read history ──────────────────────────────────────────────────────
  const probe = join(home, "probe.creds");
  writeFileSync(probe, await mintCreds(auth, newIdentity(), "probe"), { mode: 0o600 });
  const denied = await run(["history", "general", "--json", "--creds", probe, "--space", space, "--server", servers]);
  check("a credential that may not read history is a PERMISSION_DENIED refusal, exit 2, not an empty page", denied.status === 2 && denied.envelope?.outcome === "refused" && denied.envelope.error?.code === "PERMISSION_DENIED" && denied.envelope.result === null, shown(denied));
  // A credential another space's account issued is rejected, and the refusal names the space its
  // permissions name. One for this space's name from a foreign account names no other space.
  const elsewhere = join(home, "elsewhere.creds"), sameName = join(home, "same-name.creds");
  writeFileSync(elsewhere, await mintCreds(await createSpaceAuth("elsewhere"), newIdentity(), "observer"), { mode: 0o600 });
  writeFileSync(sameName, await mintCreds(await createSpaceAuth(space), newIdentity(), "observer"), { mode: 0o600 });
  const crossed = await run(["history", "general", "--json", "--creds", elsewhere, "--space", space, "--server", servers]);
  check("another space's credential is PERMISSION_DENIED, exit 2, naming the space it is for",
    crossed.status === 2 && crossed.envelope?.error?.code === "PERMISSION_DENIED" && crossed.envelope.error.message.endsWith(`${elsewhere} is a credential for space "elsewhere", not "${space}"`) && (crossed.envelope.target as { credentialSpace?: string } | null)?.credentialSpace === "elsewhere" && (crossed.envelope.error.remedy ?? "").includes(`cotal auth mint <label> --space ${space}`), shown(crossed));
  const foreign = await run(["history", "general", "--json", "--creds", sameName, "--space", space, "--server", servers]);
  check("a rejected credential naming this space keeps the plain rejection", foreign.status === 2 && foreign.envelope?.error?.code === "PERMISSION_DENIED" && /^credentials rejected at \S+$/.test(foreign.envelope.error.message), shown(foreign));
  // With that space registered here at another address, a `--server` at this broker is the mismatch:
  // the next step drops it, and following the first step with `--server` kept says so again.
  const inHome = (f: () => void) => {
    const prior = process.env.COTAL_HOME;
    process.env.COTAL_HOME = isolatedEnv.COTAL_HOME;
    try { f(); } finally { if (prior === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prior; }
  };
  const elsewhereServer = `nats://127.0.0.1:${await pickFreePort()}`;
  const elsewhereRoot = join(home, "elsewhere-root");
  mkdirSync(elsewhereRoot);
  inHome(() => recordMesh({ space: "elsewhere", server: elsewhereServer, root: elsewhereRoot, mode: "auth", origin: "manual", ts: new Date().toISOString() }));
  try {
    const byServer = await run(["history", "general", "--json", "--creds", elsewhere, "--server", servers]);
    check("with --server, the next step for a credential whose space is registered elsewhere drops --server",
      byServer.status === 2 && byServer.envelope?.error?.code === "PERMISSION_DENIED" && byServer.envelope.error.remedy === `use it with --space elsewhere and without --server, which dials elsewhere's broker at ${elsewhereServer}`, shown(byServer));
    const followed = await run(["history", "general", "--json", "--creds", elsewhere, "--space", "elsewhere", "--server", servers]);
    check("following it with --server kept names the address the space is registered at, not the plain rejection",
      followed.status === 2 && followed.envelope?.error?.code === "PERMISSION_DENIED" &&
        followed.envelope.error.message.endsWith(`${elsewhere} is a credential for space "elsewhere", which is registered here at ${elsewhereServer}, not ${servers}`) &&
        followed.envelope.error.remedy === `drop --server to use elsewhere's broker at ${elsewhereServer}, or point --server at it` &&
        (followed.envelope.target as { server?: string } | null)?.server === servers, shown(followed));
  } finally {
    inHome(() => removeMesh("elsewhere"));
  }
  // With neither --space nor --server, a credential goes to the selected space, else to the space of
  // the folder the command runs in, and a refusal names that space rather than the default.
  const selectionObserver = join(home, "selectionObserver.creds");
  writeFileSync(selectionObserver, await mintCreds(auth, newIdentity(), "observer"), { mode: 0o600 });
  const spaceOf = (r: { envelope?: Envelope }) => (r.envelope?.target as { space?: string } | null)?.space;
  const bySelection = await run(["history", "general", "--json", "--creds", selectionObserver]);
  check("--creds with no --space or --server reads the selected space", bySelection.status === 0 && bySelection.envelope?.outcome === "ok" && spaceOf(bySelection) === space, shown(bySelection));
  inHome(() => setCurrent("histunreg"));
  try {
    const unregistered = await run(["history", "general", "--json", "--creds", selectionObserver]);
    check("a selected space not registered here is refused by name, not as the default space",
      unregistered.status === 2 && unregistered.envelope?.error?.code === "TARGET_NOT_FOUND" &&
        unregistered.envelope.error.message === '--creds needs --server <url> or a registered --space: the selected space "histunreg" is not registered here, so nothing was dialed' &&
        spaceOf(unregistered) === "histunreg", shown(unregistered));
    inHome(() => clearCurrent());
    const byFolder = await run(["history", "general", "--json", "--creds", selectionObserver], meshRoot);
    check("with nothing selected, it reads the space registered for the folder it runs in", byFolder.status === 0 && spaceOf(byFolder) === space, shown(byFolder));
    const prepRoot = join(home, "prep-root");
    mkdirSync(prepRoot);
    const prepared = await run(["space", "create", "histprep"], prepRoot);
    check("control: a space is prepared in another folder", prepared.status === 0, shown(prepared));
    const unstarted = await run(["history", "general", "--json", "--creds", selectionObserver], prepRoot);
    check("there, the refusal names that folder's space",
      unstarted.status === 2 && unstarted.envelope?.error?.message === '--creds needs --server <url> or a registered --space: this folder\'s space "histprep" is not registered here, so nothing was dialed' &&
        spaceOf(unstarted) === "histprep", shown(unstarted));
    const nowhere = await run(["history", "general", "--json", "--creds", selectionObserver]);
    check("control: with nothing selected and no space in the folder, it is still the default space, not a registered one",
      nowhere.status === 2 && nowhere.envelope?.error?.message === `--creds needs --server <url> or a registered --space: the default space "main" is not registered here, so nothing was dialed` &&
        nowhere.envelope.target === null, shown(nowhere));
  } finally {
    inHome(() => setCurrent(space));
  }
  // An agent's credential reads one channel at a time through its own history consumer, and a
  // channel its grant leaves out is refused with the grant it holds.
  const agentCreds = join(home, "agent.creds");
  writeFileSync(agentCreds, await provisionAgent(provisioner, auth, newIdentity(), { lifecycleUid: mintLifecycleUid(), subscribe: [], allowSubscribe: ["general"], allowPublish: ["general"] }), { mode: 0o600 });
  const byAgent = await run(["history", "general", "--json", "--creds", agentCreds]);
  check("an agent credential whose grant names #general reads it", byAgent.status === 0 && JSON.stringify(texts(byAgent)) === JSON.stringify(["deploy started", "looks good", "deploy finished"]), shown(byAgent));
  const outside = await run(["history", "ops", "--json", "--creds", agentCreds]);
  check("a channel its grant leaves out is PERMISSION_DENIED, quoting the grant it holds",
    outside.status === 2 && outside.envelope?.error?.code === "PERMISSION_DENIED" && outside.envelope.error.message === `this credential may not read #ops in ${space}: its history grant is #general`, shown(outside));
  const everyAgent = await run(["history", "--json", "--creds", agentCreds]);
  check("with no channel named, it reads #general and names #ops as denied, quoting the grant",
    everyAgent.status === 4 && JSON.stringify(texts(everyAgent)) === JSON.stringify(["deploy started", "looks good", "deploy finished"]) &&
      (everyAgent.envelope?.warnings ?? []).some((w) => w.code === "CHANNELS_DENIED" && w.message.endsWith("; its history grant is #general")), shown(everyAgent));
  const ungranted = join(home, "agent-none.creds");
  writeFileSync(ungranted, await provisionAgent(provisioner, auth, newIdentity(), { lifecycleUid: mintLifecycleUid(), subscribe: [], allowSubscribe: [], allowPublish: ["general"] }), { mode: 0o600 });
  const none = await run(["history", "general", "--json", "--creds", ungranted]);
  check("an agent credential whose grant names no channel is refused with that grant, before any read names a subject",
    none.status === 2 && none.envelope?.error?.code === "PERMISSION_DENIED" && none.envelope.error.message === `this credential may not read #general in ${space}: its history grant is no channel`, shown(none));

  // ── a write the broker refuses for the credential's grant applied nothing ───────────────────────
  // An observer credential may read but not write channel metadata or purge history. Each refusal
  // names the profile and the write, points at the operator credential, and leaves the state that
  // the later sections read as it was.
  const observer = join(home, "observer.creds");
  writeFileSync(observer, await mintCreds(auth, newIdentity(), "observer"), { mode: 0o600 });
  const asObserver = ["--creds", observer, "--space", space, "--server", servers, "--json"];
  const deniedWrites: [string, string[], RegExp][] = [
    ["channel set", ["channel", "set", "general", "--desc", "x"], /^this observer credential may not write channel metadata in \S+, so nothing was saved: Permissions Violation/],
    ["channel remove", ["channel", "remove", "general", "--yes"], /^this observer credential may not remove channel metadata in \S+, so nothing was removed: Permissions Violation/],
    ["channel remove --purge", ["channel", "remove", "general", "--purge", "--yes"], /^this observer credential may not purge #general's history and remove its metadata in \S+, so nothing was removed: Permissions Violation/],
    ["history clear", ["history", "clear", "--yes"], /^this observer credential may not purge retained history in \S+, so nothing was purged: Permissions Violation/],
  ];
  for (const [what, args, message] of deniedWrites) {
    const r = await run([...args, ...asObserver]);
    check(`a ${what} the broker refuses is PERMISSION_DENIED, exit 2, naming the profile and the write, with the operator credential as the Next`,
      r.status === 2 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "PERMISSION_DENIED" && message.test(r.envelope.error.message) && (r.envelope.error.remedy ?? "").startsWith("run it without --creds to use the operator credential this machine records for"), shown(r));
  }

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
  // A followed line is written as watch --plain writes one: [space] time, sender, destination, text.
  const scriptShape = (l: string, sender: string, destination: string, text: string) => new RegExp(`^\\[${space}\\] \\d\\d:\\d\\d:\\d\\d  ${sender}  ${destination}  ${text}$`).test(l);
  check("--follow --plain appends each matching message as a line in watch --plain's form", shownLine && fp.lines.some((l) => scriptShape(l, "bob", "#ops", "a plain line")) && !fp.lines.some((l) => l.includes("filtered out")), fp.lines.slice(-4));
  const prefill = follow(["history", "general", "--follow", "--plain", "--limit", "1"]);
  const prefilled = await prefill.until((l) => /replay to new members/.test(l));
  prefill.child.kill("SIGINT");
  await prefill.exited;
  check("a follow prints its window in the same form as its live lines", prefilled && prefill.lines.some((l) => scriptShape(l, "\\S+", "#general", ".+")) && !prefill.lines.some((l) => /^TIME\s+WHERE/.test(l)), prefill.lines);

  // A follow whose credential expires ends on its own, with the refusal a one-shot read of that file gets.
  const brief = join(home, "brief.creds");
  writeFileSync(brief, await mintCreds(auth, newIdentity(), "observer", { expiresInSeconds: 8 }), { mode: 0o600 });
  const briefArgs = ["--creds", brief, "--space", space, "--server", servers];
  const fj = follow(["history", "general", "--follow", "--json", ...briefArgs]);
  const fl = follow(["history", "general", "--follow", "--plain", ...briefArgs]);
  const briefSnap = await fj.until((l) => l.includes('"type":"snapshot"')) && await fl.until((l) => /replay to new members/.test(l));
  const ended = await Promise.race([Promise.all([fj.exited, fl.exited]), wait(40_000).then(() => undefined)]);
  const once = await run(["history", "general", "--json", ...briefArgs]);
  const briefRecords = fj.lines.map((l) => JSON.parse(l) as { type: string; data: { code?: string; message?: string; remedy?: string; reason?: string } });
  const refusal = briefRecords.filter((r) => r.type === "error");
  check("an expired credential ends a --json follow: one AUTH_REQUIRED error record with the one-shot's message and Next, then end, exit 2",
    briefSnap && ended?.[0] === 2 && once.envelope?.error?.code === "AUTH_REQUIRED" && refusal.length === 1 && refusal[0]?.data.code === "AUTH_REQUIRED" && refusal[0].data.message === once.envelope.error.message && refusal[0].data.remedy === once.envelope.error.remedy && briefRecords.at(-1)?.type === "end" && briefRecords.at(-1)?.data.reason === "refused",
    { ended, records: fj.lines.slice(-3), stderr: fj.stderr(), once: shown(once) });
  check("an expired credential ends a --plain follow with the one-shot's refusal and no re-establishing line, exit 2",
    ended?.[1] === 2 && once.envelope?.error !== undefined && fl.stderr().includes(once.envelope.error.message) && fl.stderr().includes(once.envelope.error.remedy ?? "?") && !/re-establish|Authentication Expired/.test(fl.stderr() + fl.lines.join("\n")),
    { ended, lines: fl.lines.slice(-3), stderr: fl.stderr() });

  // A membership follow whose credential expires ends the same way, with nothing about its cleanup.
  const briefAdmin = join(home, "brief-admin.creds");
  writeFileSync(briefAdmin, await mintCreds(auth, newIdentity(), "admin", { expiresInSeconds: 8 }), { mode: 0o600 });
  const adminArgs = ["--creds", briefAdmin, "--space", space, "--server", servers];
  const mj = follow(["channel", "members", "general", "--follow", "--json", ...adminArgs]);
  const ml = follow(["channel", "members", "general", "--follow", "--plain", ...adminArgs]);
  const memberSnap = await mj.until((l) => l.includes('"type":"snapshot"'));
  const membersEnded = await Promise.race([Promise.all([mj.exited, ml.exited]), wait(40_000).then(() => undefined)]);
  const memberOnce = await run(["channel", "members", "general", "--json", ...adminArgs]);
  const memberRecords = mj.lines.map((l) => JSON.parse(l) as { type: string; data: { code?: string; message?: string; remedy?: string; reason?: string } });
  const memberErrors = memberRecords.filter((r) => r.type === "error");
  check("an expired credential ends a membership --json follow: one AUTH_REQUIRED error with the one-shot's message and Next, then end, exit 2",
    memberSnap && membersEnded?.[0] === 2 && memberOnce.envelope?.error?.code === "AUTH_REQUIRED" && memberErrors.length === 1 && memberErrors[0]?.data.code === "AUTH_REQUIRED" && memberErrors[0].data.message === memberOnce.envelope.error.message && memberErrors[0].data.remedy === memberOnce.envelope.error.remedy && memberRecords.at(-1)?.type === "end" && memberRecords.at(-1)?.data.reason === "refused",
    { membersEnded, records: mj.lines.slice(-3), stderr: mj.stderr(), once: shown(memberOnce) });
  check("an expired credential ends a membership --plain follow with the one-shot's refusal, exit 2",
    membersEnded?.[1] === 2 && memberOnce.envelope?.error !== undefined && ml.stderr().includes(memberOnce.envelope.error.message) && !/cleanup|interrupted/i.test(ml.stderr()),
    { membersEnded, stderr: ml.stderr() });

  // A credential the broker rejects, as after `reset space` replaced the trust it was minted from.
  // Given as a file it ends a follow with the one-shot's Next; minted by the follow from the space's
  // trust, the Next says to run it again.
  const rejected = await mintCreds(await createSpaceAuth(space), newIdentity(), "observer");
  const given = await credentialEnded({ server: servers, space, tls: false, creds: rejected });
  const minted = await credentialEnded({ server: servers, space, tls: false, creds: rejected, auth });
  check("a rejected --creds file ends a follow PERMISSION_DENIED with the one-shot's Next", given?.code === "PERMISSION_DENIED" && given.failure().remedy === foreign.envelope?.error?.remedy, { given: given?.failure(), oneShot: foreign.envelope?.error });
  check("a rejected credential the follow minted ends it PERMISSION_DENIED saying to run it again",
    minted?.code === "PERMISSION_DENIED" && minted.failure().message === given?.failure().message && /run it again/.test(minted.failure().remedy ?? ""), minted?.failure());

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
      const cleared = await run(["history", "clear", "--yes", "--space", openSpace]);
      const empty = await run(["history", "--space", openSpace, "--json"]);
      if (cleared.status !== 0 || empty.status !== 0 || empty.envelope?.result?.items.length !== 0)
        throw new Error(`clear fixture's valid purge control failed: ${JSON.stringify({ cleared: shown(cleared), empty: shown(empty) })}`);
      const sentinels = [`general sentinel ${randomUUID()}`, `ops sentinel ${randomUUID()}`];
      await writer.multicast(sentinels[0]!, { channel: "general" });
      await writer.multicast(sentinels[1]!, { channel: "ops" });
      const before = await run(["history", "--space", openSpace, "--json"]);
      if (before.status !== 0 || texts(before).length !== 2 || !sentinels.every((text) => texts(before).includes(text)))
        throw new Error(`clear fixture did not seed both channels: ${JSON.stringify(shown(before))}`);
      const refused = await run(["history", "clear", ...args, "--yes", "--space", openSpace]);
      const after = await run(["history", "--space", openSpace, "--json"]);
      check(`history clear refuses ${label} before purging either channel`, refused.status === 1 && after.status === 0 && texts(after).length === 2 && sentinels.every((text) => texts(after).includes(text)), { refused: shown(refused), after: shown(after) });
    }
  }

  {
    const before = await run(["history", "--dms", "--json"]);
    const cleared = await run(["history", "clear", "--yes", "--dms"]);
    const after = await run(["history", "--dms", "--json"]);
    check("explicit history clear with --dms still purges authorized channel and DM history", before.status === 0 && before.envelope?.result?.items.some((item) => item.channel !== null) === true && before.envelope?.result?.items.some((item) => item.to !== null) === true && cleared.status === 0 && after.status === 0 && after.envelope?.result?.items.length === 0, { before: shown(before), cleared: shown(cleared), after: shown(after) });
  }

  // ── a space with no channel registry ────────────────────────────────────────────────────────────
  {
    const bare = await run(["history", "general", "--space", bareSpace, "--json"]);
    const r = bare.envelope?.result;
    // The missing registry bucket reads as the built-in policy with no REPLAY_UNREAD. With no messages
    // and no saved entry, #general is a channel this space lacks, so no policy is shown for it.
    check("a space with no channel registry reads cleanly, and its empty #general is CHANNEL_NOT_FOUND with no replay policy",
      bare.status === 0 && bare.envelope?.completeness === "complete" && JSON.stringify(r?.replay) === "[]" && r?.items.length === 0
        && JSON.stringify(bare.envelope.warnings.map((w) => w.code)) === JSON.stringify(["CHANNEL_NOT_FOUND"]), shown(bare));
  }

  // ── channel remove says whether it removed a saved entry, and refuses a name the space lacks ──
  {
    const removedOf = (r: { envelope?: Envelope }) => (r.envelope?.result as { removed?: boolean } | null | undefined)?.removed;
    // The receipt used to print the stored values raw: `Replay: false` and `DeliveryClass: durable`.
    const saved = await run(["channel", "set", "general", "--no-replay", "--delivery", "durable", "--space", space, "--plain"]);
    check("a channel set receipt says replay on or off and labels the delivery class as channel show does",
      saved.status === 0 && /^\s+Replay:\s+off$/m.test(saved.stdout) && /^\s+Delivery:\s+durable$/m.test(saved.stdout) && !saved.stdout.includes("DeliveryClass") && !/Replay:\s+false/.test(saved.stdout), shown(saved));
    // The same set again used to rewrite the entry and report it saved.
    const [resetJson, resetPlain] = await Promise.all(["--json", "--plain"].map((format) => run(["channel", "set", "general", "--no-replay", "--delivery", "durable", "--space", space, format])));
    check("repeating a channel set whose values already hold is a no-op that says nothing was written",
      resetJson.status === 0 && resetJson.envelope?.outcome === "no-op" && resetPlain.stdout.includes("Channel unchanged - #general") && resetPlain.stdout.includes("#general already holds every value given, so nothing was written."), { json: shown(resetJson), plain: shown(resetPlain) });
    const removed = await run(["channel", "remove", "ops", "--yes", "--space", space, "--json"]);
    check("removing a saved channel is ok and says it removed the entry", removed.status === 0 && removed.envelope?.outcome === "ok" && removedOf(removed) === true, shown(removed));
    // history clear above left #ops with no retained message, so with its entry gone the space lacks it.
    const again = await run(["channel", "remove", "ops", "--yes", "--space", space, "--json"]);
    check("removing it again is TARGET_NOT_FOUND, exit 2, listing the registered channels",
      again.status === 2 && again.envelope?.error?.code === "TARGET_NOT_FOUND" && /#ops has no saved entry and no retained messages; registered channels: #general$/.test(again.envelope.error.message), shown(again));
    const cased = await run(["channel", "remove", "General", "--purge", "--yes", "--space", space, "--json"]);
    check("another case of a registered channel is refused before any purge, naming the registered spelling",
      cased.status === 2 && cased.envelope?.error?.code === "TARGET_NOT_FOUND" && /channel names are case-sensitive, and the registered one is #general$/.test(cased.envelope.error.message), shown(cased));
    // A channel with retained messages and no saved entry is one the space has, so its remove is a no-op.
    const posted = await run(["send", "-c", "opz", "kept", "--space", space]);
    const typo = await run(["channel", "remove", "opz", "--yes", "--space", space, "--json"]);
    check("a channel with retained messages and no saved entry is a no-op that removed nothing", posted.status === 0 && typo.status === 0 && typo.envelope?.outcome === "no-op" && removedOf(typo) === false, { posted: shown(posted), typo: shown(typo) });
  }

  // ── channel members on an open mesh, which runs no delivery service to write the feed ─────────
  {
    const members = await run(["channel", "members", "general", "--space", openSpace, "--json"]);
    const remedy = (members.envelope?.error as { remedy?: string } | undefined)?.remedy ?? "";
    check("channel members on an open mesh is UNSUPPORTED, exit 2, naming cotal who", members.status === 2 && members.envelope?.outcome === "refused" && members.envelope?.error?.code === "UNSUPPORTED" && remedy.includes("cotal who"), shown(members));
    const authMembers = await run(["channel", "members", "general", "--space", space, "--json"]);
    check("on the auth mesh it still reads the feed", authMembers.envelope?.command === "channel" && authMembers.envelope?.error?.code !== "UNSUPPORTED", shown(authMembers));
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
  const seqRefused = await readWindow(ep, conn, { ...req, since: { kind: "seq", seq: 3, text: "3", input: "3" } }).then(() => undefined, (e: { code?: string }) => e.code);
  check("a user asking for --since a sequence is refused with UNSUPPORTED", seqRefused === "UNSUPPORTED", seqRefused);
}

finish();
