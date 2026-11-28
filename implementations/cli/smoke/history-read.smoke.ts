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
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import {
  CHANNEL_DEFAULTS_KEY,
  CHAT_HISTORY_DEFAULT,
  CotalEndpoint,
  channelBucket,
  chatStream,
  chatSubject,
  createSpaceAuth,
  credsClaims,
  credsFromJwt,
  dialerFor,
  dmStream,
  idFromCreds,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  openChannelRegistry,
  openServerConfig,
  provisionAgent,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  unicastSubject,
  type ChannelRegistryRead,
} from "@cotal-ai/core";
import { awaitBrokerReady, createSuite, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { authDir, clearCurrent, recordMesh, removeMesh, saveSpaceAuth, setCurrent } from "@cotal-ai/workspace";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { execWords } from "../src/lib/exec-words.js";
import { clean, nodePty } from "./_console-pty.js";
import { credentialEnded } from "../src/lib/connect.js";
import { MAX_BUFFER } from "@cotal-ai/workspace/chat";

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
  retention: { perSender: number | null; oldestAt?: string | null; gaps: { channel: string; name: string | null; retained: number }[] } | null;
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
const dottedSpace = `histdotted-${randomUUID().slice(0, 8)}`;
// A space on the open broker that nothing has set up, so it has no channel registry bucket.
const bareSpace = `histbare-${randomUUID().slice(0, 8)}`;
const openPort = await pickFreePort();
const openServers = `nats://127.0.0.1:${openPort}`;
const openStore = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const openConfig = join(openStore, "server.conf");
writeFileSync(openConfig, openServerConfig({ transport: { kind: "plaintext" }, port: openPort, storeDir: join(openStore, "js") }));
const openBroker = spawn("nats-server", ["-c", openConfig], { stdio: "ignore" });
const releaseOpenBroker = teardownOnSignal(openBroker, openStore);

const home = mkdtempSync(join(tmpdir(), "cotal-history-home-"));
const releaseHome = teardownPathOnSignal(home);
mkdirSync(join(home, ".cotal"), { recursive: true, mode: 0o700 });
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

const run = (args: string[], cwd = shell, extra: NodeJS.ProcessEnv = {}, timeout = 120_000): Promise<{ status: number; stdout: string; stderr: string; envelope?: Envelope }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env: { ...isolatedEnv, ...extra }, timeout }, (err, stdout, stderr) => {
      const lines = stdout.split("\n").filter(Boolean);
      const envelope = lines.length === 1 && lines[0]!.startsWith("{") ? (JSON.parse(lines[0]!) as Envelope) : undefined;
      resolve({ status: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr, envelope });
    });
  });
const shown = (r: { status: number; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 1500), stderr: r.stderr.slice(0, 600) });
const texts = (r: { envelope?: Envelope }) => (r.envelope?.result?.items ?? []).map((i) => i.text);
const quotedChannel = (name: string) => process.platform === "win32" ? `"#${name}"` : `'#${name}'`;

async function checkDottedHistory(): Promise<void> {
  const dotted = "a.".repeat(2047) + "bc";
  const writer = await connect({ servers: openServers });
  try {
    const js = jetstream(writer);
    const post = (actor: string, channel: string, text: string) => js.publish(chatSubject(dottedSpace, "local", actor, channel), JSON.stringify({
      id: `${actor}-${text}`, ts: Date.now(), space: dottedSpace, from: { id: `local.${actor}`, name: actor },
      channel, parts: [{ kind: "text", text }],
    }));
    await post("seed", "ordinary", "first");
    await post("seed", dotted, "dotted");
    await Promise.all(Array.from({ length: 4 }, async (_, sender) => {
      for (let i = 0; i < 500; i++) await post(`audit${sender}`, "ordinary", String(i));
    }));
  } finally {
    await writer.close();
  }
  const history = (limit: string, ...selection: string[]) =>
    run(["history", ...selection, "--space", dottedSpace, "--limit", limit, "--json"], shell, {}, 25_000);
  const named = await history("3000", "ordinary");
  check("named history reads the ordinary backlog", named.status === 0 && texts(named).length === 2001, shown(named));
  const all = await history("3000");
  const rows = all.envelope?.result?.items ?? [];
  check("all-channel history returns a deep dotted post and the backlog in stream sequence order",
    all.status === 0 && rows.length === 2002 && rows.every((item, i) => item.seq === i + 1)
      && rows[1]?.channel === dotted && rows[1]?.text === "dotted", shown(all));
  const tail = await history("2000", "--dms");
  const tailRows = tail.envelope?.result?.items ?? [];
  check("history with DMs selects the newest rows across the split channel windows",
    tail.status === 0 && tailRows.length === 2000 && tailRows.every((item, i) => item.seq === i + 3)
      && tail.envelope?.result?.window.olderRetained === true, shown(tail));
}

async function checkChannelReplayRetry(): Promise<void> {
  const name = "remedy.probe";
  const scope = ["--space", openSpace, "--json"];
  const set = ["channel", "set", name];
  const seeded = await run([...set, "--desc", "Old note", "--window", "6h", "--replay", ...scope]);
  const changed = { replay: false, replayWindow: "48h", description: "New note", instructions: "-Owner's instructions", deliveryClass: "live" };
  const refused = await run([...set, "--desc", changed.description, "--window", changed.replayWindow,
    `--instructions=${changed.instructions}`, "--delivery", changed.deliveryClass, "--replay", "off", ...scope]);
  const readback = () => run(["channel", "show", name, ...scope]);
  const before = await readback();
  const entry = (r: Awaited<ReturnType<typeof readback>>) =>
    (r.envelope?.result as unknown as { registry?: ChannelRegistryRead } | undefined)?.registry?.channels?.[name];
  check("a replay usage refusal leaves the channel unchanged",
    seeded.status === 0 && refused.status === 1 && refused.envelope?.error?.code === "USAGE_INVALID"
      && before.status === 0 && entry(before)?.replay === true && entry(before)?.description === "Old note" && entry(before)?.replayWindow === "6h",
    { refused: shown(refused), before: shown(before) });
  const command = /^run `(.+)`$/.exec(refused.envelope?.error?.remedy ?? "")?.[1];
  const retried = command ? await run(execWords(command).slice(1)) : undefined;
  const after = await readback();
  const saved = entry(after);
  check("the replay retry keeps the settings, target and JSON output",
    retried?.status === 0 && retried.envelope?.outcome === "ok" && after.status === 0
      && Object.entries(changed).every(([key, value]) => saved?.[key as keyof typeof changed] === value),
    { command, retried: retried && shown(retried), after: shown(after) });
  const show = await run(["channel", "show", name, "--replay", "off", ...scope]);
  const read = /^run `(.+)`$/.exec(show.envelope?.error?.remedy ?? "")?.[1];
  const shownAgain = read ? await run(execWords(read).slice(1)) : undefined;
  check("a channel show replay refusal suggests a read without replay flags and keeps JSON",
    show.status === 1 && show.stderr === "" && show.envelope?.error?.code === "USAGE_INVALID"
      && read === `cotal channel show ${name} --space ${openSpace} --json`
      && shownAgain?.status === 0 && entry(shownAgain)?.replay === false,
    { show: shown(show), shownAgain: shownAgain && shown(shownAgain) });

  const explicitScope = ["--space", openSpace, "--server", openServers, "--json"];
  const leading = await run(["channel", "set", "--replay", "off", "true", "--desc", "replay probe", ...explicitScope]);
  const retry = /^run `(.+)`$/.exec(leading.envelope?.error?.remedy ?? "")?.[1];
  const savedLeading = retry ? await run(execWords(retry).slice(1)) : undefined;
  const target = await run(["channel", "show", "true", ...explicitScope]);
  const other = await run(["channel", "show", "off", ...explicitScope]);
  const entries = (r: Awaited<ReturnType<typeof run>>) =>
    (r.envelope?.result as unknown as { registry?: ChannelRegistryRead } | undefined)?.registry?.channels;
  check("a replay flag before a boolean-like channel retries the intended channel and replay setting",
    leading.status === 1 && leading.envelope?.error?.code === "USAGE_INVALID"
      && retry === `cotal channel set true --no-replay --desc 'replay probe' --space ${openSpace} --server ${openServers} --json`
      && savedLeading?.status === 0 && savedLeading.envelope?.outcome === "ok"
      && target.status === 0 && entries(target)?.true?.replay === false && entries(target)?.true?.description === "replay probe"
      && other.status === 0 && JSON.stringify(entries(other)) === "{}",
    { leading: shown(leading), retry, saved: savedLeading && shown(savedLeading), target: shown(target), other: shown(other) });

  const ambiguous = await run(["channel", "set", "true", "off", "--replay", ...explicitScope]);
  check("a boolean word not following the replay flag gets guidance without naming a channel to edit",
    ambiguous.status === 1 && ambiguous.envelope?.error?.code === "USAGE_INVALID"
      && ambiguous.envelope.error.remedy?.startsWith("name one channel") === true, shown(ambiguous));
}

async function checkFollowUsageRefusals(): Promise<void> {
  let connections = 0;
  const listener = createServer((socket) => { connections++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("expected a loopback TCP listener");
    const server = `nats://127.0.0.1:${address.port}`;
    const historyTarget = { space: null, channel: "general", dms: false };
    const membershipTarget = { space: "triage", channel: "volume.posts" };
    const recordsFrom = (stdout: string) => stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      schemaVersion?: number; stream?: string; type?: string; target?: Record<string, unknown>;
      data?: { code?: string; message?: string; remedy?: string; reason?: string; lastAsOf?: number | null };
    });
    for (const { base, invalid, stream, target, followAfter } of [
      { base: ["history", "--json"], invalid: ["--limit", "0"], stream: "history", target: { ...historyTarget, channel: null } },
      { base: ["history", "general", "--json"], invalid: ["--limit"], stream: "history", target: historyTarget, followAfter: true },
      { base: ["history", "general", "-j"], invalid: ["--unknown-option"], stream: "history", target: historyTarget },
      { base: ["channel", "members", "#volume.posts", "--space", "triage", "--json"], invalid: ["--purge"], stream: "membership", target: membershipTarget },
      { base: ["ch", "members", "volume.posts", "--space", "triage", "-j"], invalid: ["--creds"], stream: "membership", target: membershipTarget },
    ]) {
      const args = [...base, "--server", server];
      const finite = await run([...args, ...invalid]);
      const followed = await run(followAfter ? [...args, ...invalid, "--follow"] : [...args, "--follow", ...invalid]);
      const records = recordsFrom(followed.stdout);
      const error = finite.envelope?.error;
      check(`${stream} ${invalid.join(" ")} refuses with a receipt for finite reads and error then end for follows`,
        finite.status === 1 && finite.stderr === "" && finite.envelope?.command === (stream === "history" ? "history" : "channel")
          && finite.envelope.outcome === "refused" && error?.code === "USAGE_INVALID"
          && followed.status === 1 && followed.stderr === "" && connections === 0
          && records.map((record) => record.type).join() === "error,end"
          && records.every((record) => record.schemaVersion === 1 && record.stream === stream
            && Object.entries(target).every(([key, value]) => record.target?.[key] === value))
          && records[0]?.data?.code === error.code && records[0]?.data?.message === error.message && records[0]?.data?.remedy === error.remedy
          && records[1]?.data?.reason === "setup-failed" && (stream !== "membership" || records[1].data.lastAsOf === null),
        { follow: shown(followed), finite: shown(finite), connections });
    }
    for (const name of ["general", "#true"]) {
      const followed = await run(["channel", "members", "--replay", "off", name, "--follow", "--space", "triage", "--server", server, "--json"]);
      const records = recordsFrom(followed.stdout);
      const retryName = name === "general" ? name : "'#true'";
      check(`membership follow after a leading replay value names ${name} in its error and end records`,
        followed.status === 1 && followed.stderr === "" && connections === 0
          && records.map((record) => record.type).join() === "error,end"
          && records.every((record) => record.schemaVersion === 1 && record.stream === "membership"
            && record.target?.space === "triage" && record.target?.channel === name.replace(/^#/, ""))
          && records[0]?.data?.code === "USAGE_INVALID"
          && records[0]?.data?.remedy === `run \`cotal channel members ${retryName} --follow --space triage --server ${server} --json\``
          && records[1]?.data?.reason === "setup-failed" && records[1].data.lastAsOf === null,
        { follow: shown(followed), connections });
    }
    for (const args of [["history", "--json", "--limit", "--", "--follow"], ["history", "clear", "--json", "--follow", "--limit"],
      ["channel", "show", "volume.posts", "--json", "--follow", "--creds"]]) {
      const result = await run(args);
      check(`${args.join(" ")} is not a follow stream`, result.status === 1 && result.stderr === ""
        && result.envelope?.outcome === "refused" && result.envelope.error?.code === "USAGE_INVALID", shown(result));
    }
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

async function checkMembershipSetupRefusal(targetSpace: string, channel: string, code: string, ...targetFlags: string[]): Promise<void> {
  const args = ["channel", "members", channel, "--space", targetSpace, "--json", ...targetFlags];
  const finite = await run(args);
  const stream = await run([...args, "--follow"]);
  const records = stream.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    schemaVersion?: number; stream?: string; type?: string; target?: { space?: string; channel?: string };
    data?: { code?: string; message?: string; remedy?: string; reason?: string; lastAsOf?: number | null };
  });
  const error = finite.envelope?.error;
  check(`membership follow frames ${code} as an error and end with the space and channel, exit 2`,
    finite.status === 2 && finite.envelope?.command === "channel" && finite.envelope?.outcome === "refused"
      && error?.code === code && Boolean(error.remedy) && stream.status === 2 && stream.stderr === ""
      && records.map((r) => r.type).join() === "error,end" && records.every((r) =>
        r.schemaVersion === 1 && r.stream === "membership" && r.target?.space === targetSpace && r.target?.channel === channel)
      && records[0]?.data?.code === error.code && records[0]?.data?.message === error.message && records[0]?.data?.remedy === error.remedy
      && records[1]?.data?.reason === "setup-failed" && records[1]?.data?.lastAsOf === null,
    { finite: shown(finite), stream: shown(stream) });
}

async function checkUnreachableHistoryFollow(server: string): Promise<void> {
  const finite = await run(["history", "review", "--server", server, "--json"]);
  const error = finite.envelope?.error;
  for (const [scope, channel, dms] of [["review", "review", false], ["--dms", null, true]] as const) {
    const stream = await run(["history", scope, "--follow", "--server", server, "--json"]);
    const records = stream.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      schemaVersion: number; stream: string; type: string;
      target: { space: string; root?: string; channel: string | null; dms: boolean };
      data: { code?: string; message?: string; remedy?: string; reason?: string };
    });
    check(`unreachable history ${scope} follow retains its requested scope and connection target, exit 2`,
      finite.status === 2 && error?.code === "TARGET_UNAVAILABLE" && stream.status === 2 && stream.stderr === ""
        && records.map((record) => record.type).join() === "error,end"
        && records.every((record) => record.schemaVersion === 1 && record.stream === "history"
          && record.target?.space === "main" && record.target?.root === shell
          && record.target?.channel === channel && record.target?.dms === dms)
        && records[0]?.data.code === error.code && records[0]?.data.message === error.message && records[0]?.data.remedy === error.remedy
        && records[1]?.data.reason === "setup-failed", shown(stream));
  }
}

async function checkEventShapedChannelHistory(): Promise<void> {
  const channel = "events.team.standup";
  const text = "Standup marker";
  const target = ["--space", openSpace, "--server", openServers, "--json"];
  const saved = await run(["channel", "set", channel, "--desc", "Ordinary team chat", ...target]);
  const sent = await run(["send", "-c", channel, text, ...target]);
  check("fixture: an ordinary channel with an event-shaped name accepts a post", saved.status === 0 && sent.status === 0,
    { saved: shown(saved), sent: shown(sent) });
  for (const args of [[channel, "--limit", "1"], ["--limit", "2200"]]) {
    const history = await run(["history", ...args, "--grep", text, ...target]);
    const { envelope } = history;
    check(`history ${args.join(" ")} reads ordinary chat from an event-shaped channel`,
      history.status === 0 && history.stderr === "" && envelope?.completeness === "complete" && envelope.warnings.length === 0
        && envelope.result !== null && envelope.result.channels.includes(channel) && envelope.result.window.olderRetained === false
        && envelope.result.items.length === 1 && envelope.result.items[0]?.channel === channel && envelope.result.items[0]?.text === text,
      shown(history));
  }
}

async function checkGreekSigmaHistory(): Promise<void> {
  const target = ["--space", openSpace, "--server", openServers, "--json"];
  const saved = await run(["channel", "set", "greek", "--desc", "Filter demo", ...target]);
  const sent = await run(["send", "-c", "greek", "ΟΣ", ...target]);
  check("fixture: the Greek channel accepts a post", saved.status === 0 && sent.status === 0,
    { saved: shown(saved), sent: shown(sent) });
  for (const sigma of ["Σ", "σ", "ς"]) {
    const history = await run(["history", "greek", "--grep", sigma, ...target]);
    check(`history --grep ${sigma} matches the retained word-final sigma`,
      history.status === 0 && history.stderr === "" && history.envelope?.result?.window.read === 1
        && texts(history).length === 1 && texts(history)[0] === "ΟΣ",
      shown(history));
  }
}

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
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
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

async function checkWatchHistoryHint(watchedSpace: string): Promise<void> {
  const channel = "general";
  const scope = ["--space", watchedSpace];
  const text = "x".repeat(16_384) + "END OF LONG POST";
  const file = join(shell, "long.txt");
  writeFileSync(file, text);
  const set = await run(["channel", "set", channel, "--replay", "--delivery", "live", ...scope]);
  const sent = await run(["send", "-c", channel, "--file", file, ...scope]);
  check("watch history fixture stores a long post in the observed space", set.status === 0 && sent.status === 0, { set: shown(set), sent: shown(sent) });

  const observer = follow(["watch", "--plain", ...scope]);
  const marker = /\[16 text code units not shown; `((?:pnpm )?cotal history [^`]+)` carries the whole text\]$/;
  let hint: string | undefined;
  try {
    const isHint = (line: string) => line.startsWith(`[${watchedSpace}]`) && marker.test(line);
    await observer.until(isHint);
    hint = observer.lines.find(isHint)?.match(marker)?.[1];
    check("the truncated watch line prints a history command", hint !== undefined, observer.stderr());
  } finally {
    await killAndAwaitExit(observer.child, "SIGINT");
  }
  const unscoped = await run(["history", `#${channel}`, "--json"]);
  const targetSpace = (r: typeof unscoped) => (r.envelope?.target as { space?: string } | null)?.space;
  check("positive control: unscoped history targets the saved selection", targetSpace(unscoped) === space, shown(unscoped));
  if (!hint) return;
  const history = await run(execWords(hint.replace(/^(?:pnpm )?cotal /, "")));
  check("the printed history command returns the full post from the watched space",
    history.status === 0 && targetSpace(history) === watchedSpace && texts(history).includes(text), shown(history));
}

async function checkFollowResume(alice: CotalEndpoint, bob: CotalEndpoint, timestamp: string) {
  const args = ["history", "general", "--follow", "--json", "--grep", "resume boundary"];
  const parse = (line: string) => JSON.parse(line) as { type: string; data: Item & { items?: Item[] } };
  const original = follow(args);
  let events: Item[] = [];
  try {
    const ready = await original.until((line) => parse(line).type === "snapshot");
    const send = (sender: CotalEndpoint, text: string) => {
      const now = Date.now;
      Date.now = () => Date.parse(timestamp);
      try { return sender.multicast(text, { channel: "general" }); }
      finally { Date.now = now; }
    };
    await send(alice, "resume boundary one");
    await send(bob, "resume boundary two");
    const received = await original.until((line) => parse(line).data.text === "resume boundary two");
    events = original.lines.map(parse).filter((record) => record.type === "event").map((record) => record.data);
    check("the original follow emits both messages with the same timestamp and different IDs",
      ready && received && events.length === 2 && events.every((item) => item.ts === timestamp)
        && events.every((item) => Boolean(item.id)) && events[0]?.id !== events[1]?.id, events);
  } finally {
    await killAndAwaitExit(original.child, "SIGINT");
  }
  const [processed, unprocessed] = events;
  if (!processed || !unprocessed) return;

  const since = new Date(Date.parse(processed.ts) - 1).toISOString();
  const resumed = follow([...args, "--since", since]);
  try {
    const ready = await resumed.until((line) => parse(line).type === "snapshot");
    const items = resumed.lines.map(parse).find((record) => record.type === "snapshot")?.data.items ?? [];
    const unseen = items.filter((item) => item.id !== processed.id);
    check("a 1 ms overlap replays both boundary events and deduplication by ID keeps only the unread one",
      ready && items.length === 2 && items.every((item) => item.ts === processed.ts)
        && items.some((item) => item.id === processed.id) && unseen.length === 1 && unseen[0]?.id === unprocessed.id, items);
  } finally {
    await killAndAwaitExit(resumed.child, "SIGINT");
  }
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
  // Nothing has provisioned history on the open broker yet.
  const empty = await run(["history", "clear", "--server", openServers, "--yes", "--plain"]);
  check("history clear on a fresh open broker reports zero and names the absent chat stream",
    empty.status === 0 && empty.stdout.includes("0 messages purged") && empty.stderr.includes(chatStream("main")), shown(empty));
  const emptyDms = await run(["history", "clear", "--server", openServers, "--yes", "--dms", "--json"]);
  const emptyReceipt = emptyDms.envelope?.result as { acknowledged?: unknown[] } | null | undefined;
  check("history clear --dms on a fresh open broker reports a complete no-op with both stream names",
    emptyDms.status === 0 && emptyDms.envelope?.outcome === "no-op" && emptyDms.envelope.completeness === "complete"
      && emptyReceipt?.acknowledged?.length === 0 && emptyDms.envelope.warnings.some((w) => w.code === "HISTORY_STREAM_ABSENT" && w.message.includes(chatStream("main")) && w.message.includes(dmStream("main"))), shown(emptyDms));

  // A provisioner credential lives five minutes by default and this one stays connected for the
  // whole suite, which runs longer than that on a loaded machine.
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner", { expiresInSeconds: 3600 });
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  await seedChannelRegistry({ servers, space, creds: provisionerCreds, file: { channels: { general: { replay: true, replayWindow: "24h" }, ops: { replay: false } } } });
  await setupSpaceStreams({ servers: openServers, space: openSpace });
  await setupSpaceStreams({ servers: openServers, space: dottedSpace });
  const watchedSpace = `histwatch-${randomUUID().slice(0, 8)}`;
  await setupSpaceStreams({ servers: openServers, space: watchedSpace });
  saveSpaceAuth(authDir(meshRoot), auth);
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = isolatedEnv.COTAL_HOME;
  try {
    recordMesh({ space, server: servers, root: meshRoot, mode: "auth", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: openSpace, server: openServers, root: openRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: dottedSpace, server: openServers, root: openRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: bareSpace, server: openServers, root: openRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
    recordMesh({ space: watchedSpace, server: openServers, root: openRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
    setCurrent(space);
  } finally {
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
  }
  await checkDottedHistory();
  try { await checkWatchHistoryHint(watchedSpace); }
  finally {
    process.env.COTAL_HOME = isolatedEnv.COTAL_HOME;
    try { removeMesh(watchedSpace); }
    finally {
      if (priorHome === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = priorHome;
    }
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
  await bob.multicast("paging ops", { channel: "ops" });
  await alice.multicast("deploy finished", { channel: "general" });
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
  check("history with no channel reads every channel, newest last", JSON.stringify(texts(all)) === JSON.stringify(["deploy started", "looks good", "paging ops", "deploy finished"]) && all.envelope?.result?.items[2]?.channel === "ops", texts(all));

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
  const futureSeq = String(Number(all.envelope?.result?.items.at(-1)?.seq) + 2);
  const futureRead = await run(["history", "general", "--limit", "1", "--since", futureSeq, "--json"]);
  check("a future sequence cutoff returns a complete empty window even with older retained messages",
    futureRead.status === 0 && futureRead.envelope?.result?.items.length === 0
      && futureRead.envelope.result.window.olderRetained === true && futureRead.envelope.result.window.reachesSince === true, shown(futureRead));
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
  const interleavedArgs = ["history", "general", "--limit", "1", "--since", String(items[1]?.seq)];
  const [interleaved, interleavedPlain] = await Promise.all([run([...interleavedArgs, "--json"]), run([...interleavedArgs, "--plain"])]);
  const interleavedWindow = interleaved.envelope?.result?.window;
  check("an intervening post on another channel does not leave a gap after a sequence cutoff",
    interleaved.status === 0 && texts(interleaved).join() === "deploy finished"
      && interleavedWindow?.read === 1 && interleavedWindow.olderRetained === true && interleavedWindow.reachesSince === true
      && interleavedPlain.status === 0 && interleavedPlain.stdout.includes("older retained messages are not shown")
      && !interleavedPlain.stdout.includes("the window does not reach back"), { json: shown(interleaved), plain: shown(interleavedPlain) });
  const hashed = await run(["history", "#general", "--json"]);
  check("#general reads the same channel as general", JSON.stringify(texts(hashed)) === JSON.stringify(texts(general)) && hashed.envelope?.result?.channels[0] === "general", shown(hashed));
  // A channel the space lacks used to report the space's replay default as if it existed.
  const lacking = await run(["history", "nosuch", "--json"]);
  check("a channel with no messages and no saved entry warns CHANNEL_NOT_FOUND, shows no replay policy, and is still complete",
    lacking.status === 0 && lacking.envelope?.completeness === "complete" && lacking.envelope.warnings.some((w) => w.code === "CHANNEL_NOT_FOUND") && lacking.envelope.result?.replay.length === 0, shown(lacking));
  const fromBob = await run(["history", "--from", "bob", "--json"]);
  check("--from keeps one sender's messages", JSON.stringify(texts(fromBob)) === JSON.stringify(["looks good", "paging ops"]), texts(fromBob));
  for (const flag of ["--from", "--grep"]) {
    for (const value of ["", "   "]) {
      const empty = await run(["history", "general", flag, value, "--json"]);
      check(`history ${flag} ${JSON.stringify(value)} refuses USAGE_INVALID, exit 1`, empty.status === 1 && empty.envelope?.error?.code === "USAGE_INVALID", shown(empty));
    }
  }
  const grep = await run(["history", "--grep", "DEPLOY", "--json"]);
  check("--grep matches text case-insensitively within the window", JSON.stringify(texts(grep)) === JSON.stringify(["deploy started", "deploy finished"]) && grep.envelope?.result?.window.read === 4, { texts: texts(grep), window: grep.envelope?.result?.window });

  const dms = await run(["history", "--dms", "--json"]);
  const dmItems = dms.envelope?.result?.items ?? [];
  check("--dms reads both channels and adds DMs, each naming its recipient", dms.status === 0 && JSON.stringify(dmItems.filter((i) => i.channel !== null).map((i) => i.text).sort()) === JSON.stringify(texts(all).sort())
    && dmItems.some((i) => i.text === "a private note" && i.channel === null && i.to === bobId), shown(dms));
  // A DM to a recipient that had sent nothing used to show its principal; the roster names it.
  const erin = await agent("erin");
  await alice.unicast(`${erin.principal.owner}.${erin.principal.actor}`, "for erin");
  await wait(600);
  const dmsPlain = await run(["history", "--dms", "--plain"]);
  check("a DM row names its recipient from the roster when the recipient has sent nothing",
    dmsPlain.status === 0 && /DM to erin\s+alice\s+for erin/.test(dmsPlain.stdout) && /DM to bob\s+alice\s+a private note/.test(dmsPlain.stdout), dmsPlain.stdout);

  const plain = await run(["history", "general", "--plain"]);
  check("the plain report is a table and names the retention and replay", plain.status === 0 && /^TIME\s+WHERE\s+FROM\s+MESSAGE/m.test(plain.stdout) && /#general\s+alice\s+deploy started/.test(plain.stdout) && /retention: 1000 per sender on each channel; /.test(plain.stdout) && /#general replay to new members: on \(24h\)/.test(plain.stdout) && !/\x1b\[/.test(plain.stdout), shown(plain));
  const localTime = items[0] ? new Date(items[0].ts).toLocaleTimeString() : "";
  check("the plain report shows each message's local time, not the ISO time JSON carries", localTime !== "" && plain.stdout.includes(localTime) && !/\d{4}-\d\d-\d\dT\d\d:/.test(plain.stdout) && /^\d{4}-\d\d-\d\dT/.test(items[0]!.ts), { localTime, stdout: plain.stdout.slice(0, 600) });

  // ── usage ───────────────────────────────────────────────────────────────────────────────────────
  const help = await run(["history", "--help"]);
  check("history help lists a channel and --dms as alternatives and names the scope of --dms",
    help.status === 0 && help.stdout.includes("cotal history [<channel> | --dms]")
      && help.stdout.includes("read all accessible channels and DMs"), help.stdout);
  for (const args of [["general", "--dms"], ["--limit", "9007199254740992"], ["--since", "yesterday-ish"], ["--since=-5"], ["--since", "10/23/2026"], ["--since", "2026-02-30"], ["--dms", "--since", "5"], ["general", "ops"], ["--force"], ["--json", "--plain"]]) {
    const r = await run(["history", ...args, "--json"]);
    check(`history ${args.join(" ")} is one USAGE_INVALID envelope, exit 1`, r.status === 1 && r.envelope?.error?.code === "USAGE_INVALID", shown(r));
  }
  await checkFollowUsageRefusals();

  const unavailable = `nats://127.0.0.1:${await pickFreePort()}`;
  await checkUnreachableHistoryFollow(unavailable);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const root = mkdtempSync(join(home, "mode-read-"));
    const dir = join(root, ".cotal", "auth");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const args = ["history", "general", "--json", "--space", space, "--server", unavailable, "--creds", join(root, "absent.creds")];
    try {
      chmodSync(dir, 0);
      const refused = await run(args, root);
      check("an unreadable local authentication mode refuses before reading the missing credential",
        refused.status === 2 && refused.envelope?.error?.code === "PERMISSION_DENIED" && refused.envelope.error.message.includes("authentication mode")
          && (refused.envelope.target as { root?: string })?.root === realpathSync(root) && Boolean(refused.envelope.error.remedy), shown(refused));
    } finally { chmodSync(dir, 0o700); }
    const missing = await run(args, root);
    check("a readable empty mode directory reaches the missing credential refusal", missing.status === 2 && missing.envelope?.error?.code === "TARGET_NOT_FOUND", shown(missing));
  }
  const tooOld = await run(["history", "--since", "999999999999999999999999999999999999999999999999d", "--server", unavailable, "--json"]);
  check("an unrepresentable --since age is a usage error before connecting", tooOld.status === 1 && tooOld.envelope?.error?.code === "USAGE_INVALID", shown(tooOld));
  // A value that starts with a dash used to be refused by the parser as "ambiguous", and a channel
  // with `*` or a leading `#` got the subject grammar's reason.
  const [negLimit, negSince, starred] = await Promise.all([["--limit", "-1"], ["--since", "-5"], ["gen*"]].map((args) => run(["history", ...args, "--server", unavailable, "--json"])));
  check("a negative --limit or --since gets the flag's own rule, before connecting",
    negLimit.status === 1 && negLimit.envelope?.error?.message === '--limit takes a positive whole number this client can represent without rounding, not "-1"'
      && negSince.status === 1 && negSince.envelope?.error?.message === '--since takes a time (ISO 8601, or an age such as 30m, 2h, 1d) or a chat stream sequence, not "-5"', { negLimit: shown(negLimit), negSince: shown(negSince) });
  check("a channel holding * is refused with the wildcard sentence, before connecting",
    starred.status === 1 && starred.envelope?.error?.message === "name one concrete channel, without wildcards", shown(starred));
  const notADay = await run(["history", "--since", "2026-02-30", "--server", unavailable, "--json"]);
  check("a --since date that is not on the calendar is a usage error before connecting", notADay.status === 1 && notADay.envelope?.error?.message === "--since 2026-02-30 is not a calendar date", shown(notADay));
  for (const [badIso, badDate] of [["2026-02-30T00:00:00Z", "2026-02-30"], ["2026-02-29T12:00:00+01:00", "2026-02-29"], ["2026-02-30 00:00:00", "2026-02-30"]] as const) {
    const bad = await run(["history", "--since", badIso, "--server", unavailable, "--json"]);
    check(`an impossible ISO date-time (${badIso}) is refused as USAGE_INVALID before connecting`, bad.status === 1 && bad.envelope?.error?.code === "USAGE_INVALID" && bad.envelope.error.message === `--since ${badDate} is not a calendar date`, shown(bad));
  }
  const unsafeSequence = await run(["history", "--since", "9007199254740993", "--server", unavailable, "--json"]);
  check("an inexact --since sequence is a usage error before connecting", unsafeSequence.status === 1 && unsafeSequence.envelope?.error?.code === "USAGE_INVALID", shown(unsafeSequence));

  // ── a credential that may not read history ──────────────────────────────────────────────────────
  const probe = join(home, "probe.creds");
  writeFileSync(probe, await mintCreds(auth, newIdentity(), "probe"), { mode: 0o600 });
  const denied = await run(["history", "general", "--json", "--creds", probe, "--space", space, "--server", servers]);
  check("a credential that may not read history is a PERMISSION_DENIED refusal, exit 2, not an empty page", denied.status === 2 && denied.envelope?.outcome === "refused" && denied.envelope.error?.code === "PERMISSION_DENIED" && denied.envelope.result === null, shown(denied));
  // A credential another space's account issued is rejected, and the refusal names the space its
  // permissions name. One for this registered space from a foreign account names its local identity mismatch.
  const elsewhere = join(home, "elsewhere.creds"), sameName = join(home, "same-name.creds");
  writeFileSync(elsewhere, await mintCreds(await createSpaceAuth("elsewhere"), newIdentity(), "observer"), { mode: 0o600 });
  writeFileSync(sameName, await mintCreds(await createSpaceAuth(space), newIdentity(), "observer"), { mode: 0o600 });
  const crossed = await run(["history", "general", "--json", "--creds", elsewhere, "--space", space, "--server", servers]);
  check("another space's credential is PERMISSION_DENIED, exit 2, naming the space it is for",
    crossed.status === 2 && crossed.envelope?.error?.code === "PERMISSION_DENIED" && crossed.envelope.error.message.endsWith(`${elsewhere} is a credential for space "elsewhere", not "${space}"`) && (crossed.envelope.target as { credentialSpace?: string } | null)?.credentialSpace === "elsewhere" && (crossed.envelope.error.remedy ?? "").includes(`cotal auth mint <label> --space ${space}`), shown(crossed));
  const foreign = await run(["history", "general", "--json", "--creds", sameName, "--space", space, "--server", servers]);
  check("a rejected credential naming this registered space names its different local identity and the same-profile mint",
    foreign.status === 2 && foreign.envelope?.error?.code === "PERMISSION_DENIED" && foreign.envelope.error.message.includes(`space "${space}" has a different local identity`)
      && Boolean(foreign.envelope.error.remedy?.includes("cotal auth mint <label> --profile observer --out <new file>")), shown(foreign));
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
    mkdirSync(prepRoot, { mode: 0o700 });
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
  const historyAgent = newIdentity(), agentUid = mintLifecycleUid();
  const agentCredential = await provisionAgent(provisioner, auth, historyAgent, { lifecycleUid: agentUid, subscribe: [], allowSubscribe: ["general"], allowPublish: ["general"] });
  writeFileSync(agentCreds, agentCredential, { mode: 0o600 });
  const historyGrant = `$JS.API.CONSUMER.CREATE.CHAT_${space}.chathist_local-${historyAgent.id}-${agentUid}.cotal.${space}.chat.*.*.general`;
  const byAgent = await run(["history", "general", "--json", "--creds", agentCreds]);
  check("an agent credential reads #general through its exact stored history grant",
    credsClaims(agentCredential).nats?.pub?.allow?.includes(historyGrant) === true && byAgent.status === 0 && JSON.stringify(texts(byAgent)) === JSON.stringify(["deploy started", "looks good", "deploy finished"]), shown(byAgent));
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
  const f = follow(["history", "general", "--since", "0", "--follow", "--json"]);
  const snap = await f.until((l) => l.includes('"type":"snapshot"'));
  const records = () => f.lines.map((l) => JSON.parse(l) as { schemaVersion: number; stream: string; type: string; data: { text?: string; reason?: string; items?: Item[] } });
  check("--follow --json starts with one snapshot record of the window", snap && records()[0]?.type === "snapshot" && records()[0]?.stream === "history" && records()[0]?.schemaVersion === 1 && records()[0]?.data.items?.length === 3, { lines: f.lines.slice(0, 2), stderr: f.stderr() });
  const future = follow(["history", "general", "--since", futureSeq, "--follow", "--json"]);
  try {
    const ready = await future.until((line) => line.includes('"type":"snapshot"') || line.includes('"error"'));
    await alice.multicast("live one", { channel: "general" });
    const liveFuture = await future.until((line) => line.includes('"text":"live one"') || line.includes('"error"'));
    const [window, event] = future.lines.map((line) => JSON.parse(line) as { type?: string; data?: { items?: Item[]; text?: string } });
    check("a future sequence cutoff starts with an empty snapshot and still emits a live message before the cutoff",
      ready && liveFuture && window?.type === "snapshot" && window.data?.items?.length === 0
        && event?.type === "event" && event.data?.text === "live one", future.lines);
  } finally {
    await killAndAwaitExit(future.child, "SIGINT");
  }
  await bob.multicast("not this channel", { channel: "ops" });
  const event = await f.until((l) => l.includes("live one"));
  check("a message sent while following is one event record", event && records().filter((r) => r.type === "event").map((r) => r.data.text).join() === "live one", f.lines);
  // The snapshot's items carry their stream sequence. A live event has no `seq` field: the live feed
  // carries none, and a null would read as a message that has no sequence.
  const live = records().find((r) => r.type === "event");
  check("a sequence cutoff applies only to the snapshot, whose items carry their sequence",
    records()[0]?.data.items?.every((item) => typeof item.seq === "number") === true && live !== undefined && !("seq" in live.data), { snapshot: records()[0]?.data.items?.map((item) => item.seq), event: live?.data });
  f.child.kill("SIGINT");
  const code = await f.exited;
  check("an interrupted follow ends with an end record and exit 130", code === 130 && records().at(-1)?.type === "end" && records().at(-1)?.data.reason === "interrupted", { code, last: f.lines.at(-1), stderr: f.stderr() });
  check("every follow line is one parseable stream record", f.lines.every((l) => { try { const r = JSON.parse(l); return r.schemaVersion === 1 && r.stream === "history"; } catch { return false; } }), f.lines);

  const timed = follow(["history", "general", "--since", midpoint, "--follow", "--json"]);
  const timedSnap = await timed.until((l) => l.includes('"type":"snapshot"'));
  // Stamp only the outgoing envelope with the cutoff, then send a later event on the same channel.
  const now = Date.now;
  const atCutoff = (() => {
    Date.now = () => Date.parse(midpoint);
    try { return alice.multicast("at the cutoff", { channel: "general" }); }
    finally { Date.now = now; }
  })();
  await atCutoff;
  await alice.multicast("after the cutoff", { channel: "general" });
  const timedEvent = await timed.until((l) => l.includes('"text":"after the cutoff"'));
  timed.child.kill("SIGINT");
  await timed.exited;
  const timedEvents = timed.lines.map((l) => JSON.parse(l) as { type: string; data: { text?: string } }).filter((r) => r.type === "event");
  check("a live follow excludes an event at the time cutoff and emits a later event",
    timedSnap && timedEvent && timedEvents.map((r) => r.data.text).join() === "after the cutoff", timed.lines);
  await checkFollowResume(alice, bob, midpoint);

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

  const scopedAll = follow(["history", "--follow", "--json", "--creds", agentCreds]);
  const scopedNamed = follow(["history", "general", "--follow", "--json", "--creds", agentCreds]);
  try {
    const hasSnapshot = (line: string) => line.includes('"type":"snapshot"');
    const snapshots = await Promise.all([scopedAll, scopedNamed].map((f) => f.until(hasSnapshot)));
    await bob.multicast("outside scoped follow", { channel: "ops" });
    await alice.multicast("inside scoped follow", { channel: "general" });
    await Promise.all([scopedAll, scopedNamed].map((f) => f.until((line) => line.includes('"text":"inside scoped follow"') || line.includes('"type":"error"'))));
    await Promise.all([scopedAll, scopedNamed].map((f) => killAndAwaitExit(f.child, "SIGTERM")));
    const codes = await Promise.all([scopedAll.exited, scopedNamed.exited]);
    for (const [i, f] of [scopedAll, scopedNamed].entries()) {
      const records = f.lines.map((line) => JSON.parse(line) as { type: string; data: { text?: string; reason?: string } });
      check(`a scoped credential follows ${i === 0 ? "all granted channels" : "a named channel"} without subscription errors or out-of-scope events`,
        snapshots[i] && codes[i] === 143 && records.map((r) => r.type).join() === "snapshot,event,end" && records[1]?.data.text === "inside scoped follow" && records[2]?.data.reason === "terminated", f.lines);
    }
  } finally {
    await Promise.all([scopedAll, scopedNamed].map((f) => killAndAwaitExit(f.child, "SIGTERM")));
  }
  const noFollow = await run(["history", "--follow", "--json", "--creds", ungranted]);
  const noFollowRecords = noFollow.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: { code?: string; reason?: string } });
  check("an all-channel follow with no channel read grant refuses without opening a feed",
    noFollow.status === 2 && noFollowRecords.map((r) => r.type).join() === "error,end" && noFollowRecords[0]?.data.code === "PERMISSION_DENIED" && noFollowRecords[1]?.data.reason === "setup-failed", shown(noFollow));

  // A raw credential can have a broader retained read than live read. The broker's live denial
  // must still end the all-channel follow, rather than leave an apparently running feed.
  const retainedReader = newIdentity();
  const { pub, sub } = credsClaims(await mintCreds(auth, retainedReader, "observer")).nats!;
  const signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
  const restricted = join(home, "retained-reader.creds");
  try {
    const chat = chatSubject(space, "*", "*", "general");
    const jwt = await encodeUser("observer", fromPublic(retainedReader.id), fromPublic(auth.account.pub), {
      pub,
      sub: { allow: [...(sub?.allow ?? []).filter((row) => !row.startsWith(`cotal.${space}.chat.`)), chat] },
    }, { signer, exp: Math.floor(Date.now() / 1000) + 600 });
    writeFileSync(restricted, credsFromJwt(jwt, retainedReader), { mode: 0o600 });
  } finally { signer.clear(); }
  const refusedFollow = follow(["history", "--follow", "--json", "--creds", restricted]);
  try {
    const ended = await refusedFollow.until((line) => line.includes('"type":"end"'));
    const records = refusedFollow.lines.map((line) => JSON.parse(line) as { type: string; data: { code?: string; message?: string; remedy?: string; reason?: string } });
    check("a broker denial names the exact live wildcard, ends the follow and says to name a channel",
      ended && await refusedFollow.exited === 2 && records.map((r) => r.type).join() === "error,end" && records[0]?.data.code === "PERMISSION_DENIED" &&
      records[0]?.data.message?.includes(`"cotal.${space}.chat.>"`) === true && records[0]?.data.remedy?.includes("name a channel") === true && records[1]?.data.reason === "setup-failed", refusedFollow.lines);
  } finally { await killAndAwaitExit(refusedFollow.child, "SIGTERM"); }

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
  // A raw connection with no file or local trust context keeps the broker's generic guidance;
  // minted by the follow from the space's trust, the Next says to run it again.
  const rejected = await mintCreds(await createSpaceAuth(space), newIdentity(), "observer");
  const given = await credentialEnded({ server: servers, space, tls: false, creds: rejected });
  const minted = await credentialEnded({ server: servers, space, tls: false, creds: rejected, auth });
  check("a rejected raw credential ends a follow PERMISSION_DENIED without claiming a local identity change", given?.code === "PERMISSION_DENIED" && given.failure().message === `credentials rejected at ${servers}` && given.failure().remedy === "check your creds, or the broker wants different auth", given?.failure());
  check("a rejected credential the follow minted ends it PERMISSION_DENIED saying to run it again",
    minted?.code === "PERMISSION_DENIED" && minted.failure().message === given?.failure().message && /run it again/.test(minted.failure().remedy ?? ""), minted?.failure());
  const expiredSelfMinted = await credentialEnded({ server: servers, space, tls: false, creds: await mintCreds(auth, newIdentity(), "observer", { expiresAt: Math.floor(Date.now() / 1000) - 10 }), auth });
  check("an expired self-minted credential ends AUTH_REQUIRED telling the caller to run the command again, not doctor auth or re-mint",
    expiredSelfMinted?.code === "AUTH_REQUIRED" && /run the command again/.test(expiredSelfMinted.failure().remedy ?? "") && !/doctor auth|re-mint/i.test(expiredSelfMinted.failure().remedy ?? ""), expiredSelfMinted?.failure());

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

  // `--limit` bounds messages, and one message can be close to a megabyte, so a row shows the first
  // 500 code units and names how many it did not show. `--json` carries the text as it was sent.
  const long = `long ${"y".repeat(5000)}`;
  await bob.multicast(long, { channel: "ops" });
  await wait(500);
  const longPlain = await run(["history", "ops", "--limit", "1", "--plain"]);
  const longJson = await run(["history", "ops", "--limit", "1", "--json"]);
  check("a plain row shows the first 500 code units of a long message and names the code units not shown; --json keeps the whole text",
    longPlain.status === 0 && longPlain.stdout.includes(`long ${"y".repeat(495)}`) && !longPlain.stdout.includes("y".repeat(496))
      && longPlain.stdout.includes(`${long.length - 500} text code units not shown; --json carries the whole text`) && texts(longJson)[0] === long,
    { plain: longPlain.stdout.slice(-300), json: texts(longJson)[0]?.length });

  // Payload times can disagree with broker arrival order across publishers.
  {
    const nc = await connect({ servers: openServers });
    const js = jetstream(nc);
    const now = Date.now();
    const publish = (subject: string, actor: string, id: string, ts: number, target: { channel: string } | { to: string }) =>
      js.publish(subject, JSON.stringify({ id, ts, space: openSpace, from: { id: `local.${actor}`, name: actor }, ...target, parts: [{ kind: "text", text: id }] }));
    try {
      const first = await publish(chatSubject(openSpace, "local", "alice", "volume"), "alice", "arrived-first", now, { channel: "volume" });
      const second = await publish(chatSubject(openSpace, "local", "bob", "volume"), "bob", "arrived-second", now - 2_000, { channel: "volume" });
      const args = ["--space", openSpace, "--json"];
      const channel = await run(["history", "volume", ...args]);
      const emptyDms = await run(["history", "--dms", ...args]);
      const sequences = (r: typeof channel) => r.envelope?.result?.items.filter((item) => item.channel === "volume").map((item) => item.seq).join();
      const expected = [first.seq, second.seq].join();
      check("--dms with no DMs keeps the same broker sequence as channel history",
        channel.status === 0 && emptyDms.status === 0 && sequences(channel) === expected && sequences(emptyDms) === expected,
        { channel: shown(channel), mixed: shown(emptyDms) });

      const cutoff = new Date(now - 2_000).toISOString();
      const timeArgs = ["history", "volume", "--since", cutoff, "--space", openSpace];
      const limited = await run([...timeArgs, "--limit", "1", "--json"]);
      const complete = await run([...timeArgs, "--limit", "2", "--json"]);
      const plain = await run([...timeArgs, "--limit", "1", "--plain"]);
      check("a time cutoff at the first row cannot bound unread rows in broker order",
        limited.status === 0 && texts(limited).length === 0 && limited.envelope?.result?.window.read === 1
          && limited.envelope.result.window.olderRetained === true && limited.envelope.result.window.reachesSince === false
          && complete.status === 0 && texts(complete).join() === "arrived-first" && sequences(complete) === String(first.seq)
          && complete.envelope?.result?.window.olderRetained === false && complete.envelope.result.window.reachesSince === true
          && plain.status === 0 && plain.stdout.includes(`the window may omit retained messages after --since ${cutoff}`),
        { limited: shown(limited), complete: shown(complete), plain: shown(plain) });

      const dmSubject = unicastSubject(openSpace, "local", "bob", "local", "alice");
      await publish(dmSubject, "alice", "older-direct", now - 3_000, { to: "local.bob" });
      await publish(dmSubject, "alice", "direct", now - 1_000, { to: "local.bob" });
      const mixed = await run(["history", "--dms", ...args]);
      const narrow = await run(["history", "--dms", "--limit", "2", ...args]);
      check("--dms preserves channel sequence with a DM present and retains the newest channel post in a two-row window",
        mixed.status === 0 && texts(mixed).includes("direct") && sequences(mixed) === expected && narrow.status === 0
          && texts(narrow).includes("direct") && sequences(narrow) === String(second.seq) && narrow.envelope?.result?.window.olderRetained === true,
        { mixed: shown(mixed), narrow: shown(narrow) });
      const byTime = await run(["history", "--dms", "--limit", "3", "--since", new Date(now - 1_500).toISOString(), ...args]);
      check("a mixed window with unread rows cannot establish time cutoff coverage",
        byTime.status === 0 && byTime.envelope?.result?.window.olderRetained === true
          && byTime.envelope.result.window.reachesSince === false && texts(byTime).join() === "arrived-first,direct",
        shown(byTime));
    } finally {
      await nc.close();
    }
  }

  // ── a retention gap ─────────────────────────────────────────────────────────────────────────────
  {
    const cap = CHAT_HISTORY_DEFAULT.perSubject;
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
    check("the report names the gap as possible loss", new RegExp(`gap: #general holds ${cap} from carol, the per-sender limit, so their older messages there may be gone`).test(gapPlain.stdout), gapPlain.stdout);
    check("...and the time of the oldest post the stream still holds", typeof r?.retention?.oldestAt === "string" && /the oldest post the chat stream still holds is from .+; posts sent before it are gone/.test(gapPlain.stdout), { oldestAt: r?.retention?.oldestAt, stdout: gapPlain.stdout });
    const expanded = await run(["history", "general", "--space", openSpace, "--limit", "1001", "--json"]);
    check("a larger window reads every retained message without duplicates", expanded.status === 0 && texts(expanded).length === 1001 && new Set(expanded.envelope?.result?.items.map((item) => item.id)).size === 1001, shown(expanded));
    check("the expanded window is ordered and reaches the oldest retained message", texts(expanded)[0] === "carol 3" && expanded.envelope?.result?.window.olderRetained === false && expanded.envelope.result.items.every((item, i, rows) => i === 0 || item.seq! > rows[i - 1]!.seq!), expanded.envelope?.result?.window);
    const older = await run(["history", "general", "--space", openSpace, "--limit", "2000", "--since", "0", "--grep", "carol 3", "--json"]);
    check("since and grep can reach past the newest thousand", older.status === 0 && texts(older).includes("carol 3") && older.envelope?.result?.window.reachesSince === true, shown(older));
    const confined = await talker.channelHistoryPage("general", { limit: 2000 });
    check("the lifecycle-confined reader also accepts a window beyond a thousand", confined.complete && confined.items.length === 1001, { complete: confined.complete, count: confined.items.length });
    // Every bounded window tells the reader how to reach older retained messages.
    const [capPlain, fromCarol] = await Promise.all([
      run(["history", "general", "--space", openSpace, "--limit", "1000", "--plain"]),
      run(["history", "general", "--space", openSpace, "--limit", "1000", "--from", "carol", "--plain"]),
    ]);
    check("at --limit 1000 the report names a larger window",
      capPlain.stdout.includes("older retained messages are not shown; raise --limit to read further back\n"), shown(capPlain));
    check("below it the report still names the raise", gapPlain.stdout.includes("older retained messages are not shown; raise --limit to read further back\n"), shown(gapPlain));
    check("--from with older retained messages says it searched only the messages read",
      fromCarol.status === 0 && fromCarol.stdout.includes("--from carol searched only the 1000 read; older retained messages were not searched\n"), shown(fromCarol));
  }

  // Channel receipts and reads recommend scoped commands even when the channel name is a history verb.
  {
    const channels = ["clear", "limit", "baseline"];
    const scope = ["--space", openSpace, "--server", openServers];
    const printedLines = (stdout: string) => stdout.split("\n").map((line) => line.trim().replace(/^pnpm cotal /, "cotal "));
    for (const channel of channels) {
      const saved = await run(["channel", "set", channel, "--desc", "History hint test", ...scope, "--plain"]);
      const posted = await run(["send", "-c", channel, `retained in ${channel}`, "--space", openSpace]);
      if (saved.status !== 0 || posted.status !== 0)
        throw new Error(`could not seed #${channel}: ${JSON.stringify({ saved: shown(saved), posted: shown(posted) })}`);
      if (channel !== "clear") continue;
      const suggestion = (verb: string) => printedLines(saved.stdout).find((line) => line.startsWith(`cotal ${verb} `))?.split(/  +/)[0];
      const inventory = suggestion("ch");
      const history = suggestion("history");
      const target = scope.join(" ");
      const listed = inventory === `cotal ch ${target}` ? await run([...execWords(inventory).slice(1), "--plain"]) : undefined;
      const read = history === `cotal history ${quotedChannel("clear")} ${target}` ? await run([...execWords(history).slice(1), "--json"]) : undefined;
      check("channel set receipt inventory keeps the explicit target when another space is selected",
        listed?.status === 0 && listed.stdout.includes(`Mesh: ${openSpace}`) && listed.stdout.includes("#clear"), { receipt: shown(saved), listed });
      check("channel set receipt history reads the quoted channel instead of the history verb",
        read?.status === 0 && texts(read).includes("retained in clear"), { receipt: shown(saved), read });
    }
    for (const channel of channels) {
      const card = await run(["channel", "show", channel, "--space", openSpace, "--plain"]);
      const [, command] = card.stdout.match(/^\s+((?:pnpm )?cotal history .+?) {2,}Read retained messages within your grant\r?$/m) ?? [];
      // Only execute the quoted channel form. An unexpected administrative command is a test failure.
      const read = command && ["cotal", "pnpm cotal"].some((cli) => command === `${cli} history ${quotedChannel(channel)} --space ${openSpace}`)
        ? spawnSync(`${command.replace(/^(?:pnpm )?cotal /, () => `"${process.execPath}" "${BIN}" `)} --json`,
          { shell: true, cwd: shell, env: isolatedEnv, encoding: "utf8", timeout: 120_000 }) : undefined;
      const messages = read?.status === 0 ? (JSON.parse(read.stdout) as Envelope).result?.items : undefined;
      check(`pasting the channel show #${channel} history command reads that channel only`,
        card.status === 0 && read?.status === 0 && messages?.length === 1
          && messages[0]?.channel === channel && messages[0].text === `retained in ${channel}`,
        { card: shown(card), read: read && { status: read.status, stdout: read.stdout, stderr: read.stderr, error: read.error } });
    }
    const writer = join(home, "channel writer.creds");
    writeFileSync(writer, await mintCreds(auth, newIdentity(), "channel-writer"), { mode: 0o600 });
    const credentialScope = ["--space", space, "--server", servers, "--creds", writer];
    const saved = await run(["channel", "set", "receipt-test", "--desc", "Scoped credential", ...credentialScope, "--plain"]);
    const commands = printedLines(saved.stdout).filter((line) => line.startsWith("cotal ")).map((line) => execWords(line.split(/  +/)[0]!));
    check("both receipt commands retain the explicit credential path as one argument", saved.status === 0 &&
      JSON.stringify(commands) === JSON.stringify([["cotal", "ch", ...credentialScope], ["cotal", "history", "#receipt-test", ...credentialScope]]), shown(saved));
    if (saved.status === 0) {
      const removed = await run(["channel", "remove", "receipt-test", "--space", space, "--yes", "--json"]);
      check("the credential receipt fixture is removed", removed.status === 0, shown(removed));
    }
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

    const before = await run(["history", "--space", openSpace, "--json"]);
    for (const [path, force] of [["./absent store", false], ["./absent store", true], ["", true], ["~/store", true]] as const) {
      const refused = await run(["clean", "history", "--store-dir", path, "--space", openSpace, ...(force ? ["--force"] : [])]);
      const after = await run(["history", "--space", openSpace, "--json"]);
      check(`clean history refuses --store-dir ${JSON.stringify(path)} ${force ? "with" : "without"} --force and preserves live history`,
        refused.status === 1 && refused.stderr.includes("clean history targets a running mesh")
        && refused.stderr.includes("Only clean store and clean all take --store-dir")
        && !/cotal clean history.*--force|omit --store-dir/.test(refused.stderr)
        && before.status === 0 && texts(before).length === 2 && after.status === 0
        && JSON.stringify(after.envelope?.result?.items) === JSON.stringify(before.envelope?.result?.items),
        { refused: shown(refused), before: shown(before), after: shown(after) });
    }

    for (const force of [false, true]) {
      const refused = await run(["clean", "history", "--server", openServers, "--space", openSpace,
        "--attempt", "restore-00000000-0000-4000-8000-000000000000", ...(force ? ["--force"] : [])]);
      const after = await run(["history", "--space", openSpace, "--json"]);
      check(`clean history refuses --attempt ${force ? "with" : "without"} --force and preserves live history`,
        refused.status === 1 && refused.stderr.includes("clean history cannot be scoped by --attempt")
        && refused.stderr.includes("selects a restore") && refused.stderr.includes("Nothing was purged")
        && !/cotal clean history.*--force/.test(refused.stderr)
        && before.status === 0 && texts(before).length === 2 && after.status === 0
        && JSON.stringify(after.envelope?.result?.items) === JSON.stringify(before.envelope?.result?.items),
        { refused: shown(refused), before: shown(before), after: shown(after) });
    }
  }

  {
    const before = await run(["history", "--dms", "--json"]);
    const cleared = await run(["history", "clear", "--yes", "--dms"]);
    const after = await run(["history", "--dms", "--json"]);
    check("explicit history clear with --dms still purges authorized channel and DM history", before.status === 0 && before.envelope?.result?.items.some((item) => item.channel !== null) === true && before.envelope?.result?.items.some((item) => item.to !== null) === true && cleared.status === 0 && after.status === 0 && after.envelope?.result?.items.length === 0, { before: shown(before), cleared: shown(cleared), after: shown(after) });
  }

  await alice.unicast(bobId, "one retained DM");
  const exact = await run(["history", "--dms", "--limit", "1", "--json"]);
  const widest = await run(["history", "--dms", "--limit", String(Number.MAX_SAFE_INTEGER), "--json"]);
  check("one DM fills a one-row window without omitting older history",
    exact.status === 0 && exact.envelope?.result?.window.olderRetained === false && texts(exact).join() === "one retained DM", shown(exact));
  check("the largest supported DM history limit still reads the available history",
    widest.status === 0 && widest.envelope?.result?.window.olderRetained === false && texts(widest).join() === "one retained DM", shown(widest));

  await alice.unicast(bobId, "second retained DM");
  const more = await run(["history", "--dms", "--limit", "1", "--json"]);
  check("two retained DMs read at limit one show the latest and report the omission",
    more.status === 0 && more.envelope?.result?.window.olderRetained === true && texts(more).join() === "second retained DM", shown(more));
  await run(["history", "clear", "--yes", "--dms"]);

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
    // The card names the inbox bound a chat session's replay keeps, from the constant that sets it.
    const [onCard, offCard] = await Promise.all(["general", "ops"].map((channel) => run(["channel", "show", channel, "--space", space, "--plain"])));
    check(`channel show names the newest ${MAX_BUFFER} a chat session replays, and only when replay is on`,
      onCard.status === 0 && new RegExp(`^\\s+Chat replay:\\s+the newest ${MAX_BUFFER} messages in the window$`, "m").test(onCard.stdout) && offCard.status === 0 && !offCard.stdout.includes("Chat replay"), { on: shown(onCard), off: shown(offCard) });
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
    const upper = "reports.Daily", lower = "reports.daily";
    for (const channel of [upper, lower]) {
      const saved = await run(["channel", "set", channel, "--desc", channel, "--space", openSpace]);
      const posted = await run(["send", "-c", channel, `retained in ${channel}`, "--space", openSpace]);
      if (saved.status !== 0 || posted.status !== 0) throw new Error(`could not seed #${channel}: ${JSON.stringify({ saved: shown(saved), posted: shown(posted) })}`);
    }
    const purge = ["channel", "remove", lower, "--purge", "--yes", "--space", openSpace, "--json"];
    const purged = await run(purge);
    const cased = await run(purge);
    const remedy = cased.envelope?.error?.remedy;
    const inspect = remedy === `inspect the registered spelling: \`cotal channel show ${upper} --space ${openSpace}\``
      ? await run(["channel", "show", upper, "--space", openSpace, "--plain"]) : undefined;
    const kept = await run(["history", `#${upper}`, "--space", openSpace, "--json"]);
    check("repeating a confirmed purge suggests inspecting the differently cased channel and preserves its message",
      purged.status === 0 && (purged.envelope?.result as { purged?: number } | null)?.purged === 1
        && cased.status === 2 && cased.envelope?.error?.code === "TARGET_NOT_FOUND"
        && cased.envelope.error.message.includes(`#${lower} has no saved entry and no retained messages`)
        && inspect?.status === 0 && inspect.stdout.includes(`Channel - #${upper}`) && kept.status === 0 && texts(kept).join() === `retained in ${upper}`,
      { purged: shown(purged), refused: shown(cased), inspect: inspect && shown(inspect), history: shown(kept) });
    const removedReports = await run(["channel", "remove", upper, "--purge", "--yes", "--space", openSpace]);
    check("the remaining case can be purged with its own exact confirmation", removedReports.status === 0, shown(removedReports));
    // A channel with retained messages and no saved entry is one the space has, so its remove is a no-op.
    const posted = await run(["send", "-c", "opz", "kept", "--space", space]);
    const typo = await run(["channel", "remove", "opz", "--yes", "--space", space, "--json"]);
    check("a channel with retained messages and no saved entry is a no-op that removed nothing", posted.status === 0 && typo.status === 0 && typo.envelope?.outcome === "no-op" && removedOf(typo) === false, { posted: shown(posted), typo: shown(typo) });
    // A purger credential purges history and holds nothing on the channel registry. Its purge-and-remove
    // purges, then cannot remove the entry: a partial outcome naming the purge, never "nothing was removed".
    const purger = join(home, "purger.creds");
    writeFileSync(purger, await mintCreds(auth, newIdentity(), "purger"), { mode: 0o600 });
    const made = await run(["channel", "set", "scratch", "--desc", "x", "--space", space, "--json"]);
    const partial = await run(["channel", "remove", "scratch", "--purge", "--yes", "--creds", purger, "--space", space, "--server", servers, "--json"]);
    const cleaned = await run(["channel", "remove", "scratch", "--yes", "--space", space, "--json"]);
    check("a purge-and-remove whose registry step is refused is OPERATION_PARTIAL, exit 4, naming the purge it made",
      made.status === 0 && partial.status === 4 && partial.envelope?.outcome === "partial" && partial.envelope.error?.code === "OPERATION_PARTIAL"
        && /^The purge reported 0 messages removed, but channel metadata removal was not confirmed\./.test(partial.envelope.error.message) && cleaned.status === 0 && removedOf(cleaned) === true,
      { made: shown(made), partial: shown(partial), cleaned: shown(cleaned) });
    // The confirmation keeps the requested target, purge scope and output format.
    const asked = await run(["channel", "remove", "general", "--purge", "--space", space, "--server", servers, "--json"]);
    check("channel remove without --yes names a confirming command that keeps --space, --server, --purge and --json",
      asked.envelope?.error?.remedy === `confirm with \`cotal channel remove general --space ${space} --server ${servers} --purge --yes --json\``, shown(asked));
  }

  // Channel policy labels describe each field's source, including explicit values equal to defaults.
  {
    const channel = (...args: string[]) => run(["channel", ...args, "--space", space, "--plain"]);
    const fields = (stdout: string) => Object.fromEntries([...stdout.matchAll(/^\s+(Replay|Window|Delivery):\s+(.+)$/gm)].map((match) => [match[1], match[2]]));
    const policyIs = (r: { status: number; stdout: string }, replay: string, window: string, delivery: string) =>
      r.status === 0 && JSON.stringify(fields(r.stdout)) === JSON.stringify({ Replay: replay, Window: window, Delivery: delivery });
    const row = (stdout: string, name: string) => stdout.split("\n").find((line) => line.trimStart().startsWith(`#${name} `))?.trim().replace(/\s{2,}/g, "  ");
    const builtIn = await channel("show", "policy-unregistered");
    const builtInDefaults = await channel("defaults");
    check("built-in replay, retained-history window and delivery are marked inherited",
      policyIs(builtIn, "on - inherited", "retained history - inherited", "durable - inherited")
        && policyIs(builtInDefaults, "on - inherited", "retained history - inherited", "durable - inherited"), { show: shown(builtIn), defaults: shown(builtInDefaults) });
    const defaults = await channel("defaults", "--delivery", "live", "--no-replay", "--window", " 1h ");
    const created = await channel("set", "policy", "--desc", "Operations");
    check("control: channel policy defaults and metadata are saved through the CLI", defaults.status === 0 && created.status === 0, { defaults: shown(defaults), created: shown(created) });
    const inherited = await channel("show", "policy");
    const listed = await channel();
    check("channel show marks every inherited policy field with inherited",
      policyIs(inherited, "off - inherited", "1h - inherited", "live - inherited"), shown(inherited));
    check("channel list uses inherited for replay and delivery as show does",
      listed.status === 0 && row(listed.stdout, "policy") === "#policy  Operations  off - inherited  live - inherited", shown(listed));
    const defaultsCard = await channel("defaults");
    check("saved channel defaults are explicit and carry no inheritance marks", policyIs(defaultsCard, "off", "1h", "live"), shown(defaultsCard));
    // The defaults report's Next command acts on the space it just inspected, keeping the broker
    // it was read from, so running it as printed cannot edit another space.
    const defaultsNext = await run(["channel", "defaults", "--space", space, "--server", servers, "--plain"]);
    check("the channel defaults report names a Next command that keeps the inspected space and broker",
      defaultsNext.status === 0 && defaultsNext.stdout.includes(`cotal ch defaults --replay --window 24h --space ${space} --server ${servers}`), shown(defaultsNext));
    const observerDefaults = await run(["channel", "defaults", "--creds", observer, "--server", servers, "--space", space, "--json"]);
    const observerRegistry = (observerDefaults.envelope?.result as { registry?: ChannelRegistryRead })?.registry;
    check("channel defaults JSON scopes the registry read with an observer credential",
      observerDefaults.status === 0 && observerDefaults.stderr === ""
        && Object.keys(observerRegistry ?? {}).join() === "defaults" && observerRegistry?.defaults?.replay === false
        && observerRegistry.defaults.replayWindow === "1h" && observerRegistry.defaults.deliveryClass === "live", shown(observerDefaults));
    const missing = await channel("show", "policy-unregistered");
    check("an unsaved channel marks every field inherited too", policyIs(missing, "off - inherited", "1h - inherited", "live - inherited"), shown(missing));
    const mixedSet = await channel("set", "policy", "--no-replay");
    const mixed = await channel("show", "policy");
    const mixedList = await channel();
    check("an explicit false equal to the default is unmarked while other fields stay inherited",
      mixedSet.status === 0 && policyIs(mixed, "off", "1h - inherited", "live - inherited") && mixedList.status === 0
        && row(mixedList.stdout, "policy") === "#policy  Operations  off  live - inherited", { show: shown(mixed), list: shown(mixedList) });
    const explicitSet = await channel("set", "policy", "--replay", "--window", "30m", "--delivery", "durable");
    const explicit = await channel("show", "policy");
    const explicitList = await channel();
    check("control: explicit replay, window and delivery overrides carry no inheritance marks",
      explicitSet.status === 0 && policyIs(explicit, "on", "30m", "durable") && explicitList.status === 0
        && row(explicitList.stdout, "policy") === "#policy  Operations  on  durable", { show: shown(explicit), list: shown(explicitList) });
    const sameSet = await channel("set", "policy", "--no-replay", "--window", "1h", "--delivery", "live");
    const same = await channel("show", "policy");
    const sameList = await channel();
    check("explicit settings equal to defaults are still unmarked",
      sameSet.status === 0 && policyIs(same, "off", "1h", "live") && sameList.status === 0
        && row(sameList.stdout, "policy") === "#policy  Operations  off  live", { show: shown(same), list: shown(sameList) });
  }

  // Scoped channel reads return the raw defaults and only the entries they request.
  {
    const registrySpace = `histreg-${randomUUID().slice(0, 8)}`;
    const json = (...args: string[]) => run(["channel", ...args, "--space", registrySpace, "--server", openServers, "--json"]);
    const registryOf = (r: Awaited<ReturnType<typeof run>>) =>
      (r.envelope?.result as { registry?: ChannelRegistryRead } | null | undefined)?.registry;
    const absent = await json("defaults");
    check("channel defaults JSON leaves absent defaults unset",
      absent.status === 0 && absent.stderr === "" && JSON.stringify(registryOf(absent)) === "{}", shown(absent));
    const defaults = await json("defaults", "--delivery", "live", "--no-replay", "--window", "2h");
    const saved = await json("set", "__proto__", "--desc", "Operations");
    const other = await json("set", "elsewhere", "--desc", "Elsewhere");
    const inventory = await json();
    const full = registryOf(inventory);
    check("control: channel inventory JSON returns both saved entries and the raw defaults",
      defaults.status === 0 && saved.status === 0 && other.status === 0 && inventory.status === 0
        && full?.channels?.elsewhere?.description === "Elsewhere"
        && Object.hasOwn(full?.channels ?? {}, "__proto__") && full?.channels?.__proto__?.description === "Operations"
        && full?.defaults?.deliveryClass === "live" && full.defaults?.replay === false && full.defaults?.replayWindow === "2h",
      { defaults: shown(defaults), saved: shown(saved), other: shown(other), inventory: shown(inventory) });
    const savedDefaults = await json("defaults");
    check("channel defaults JSON returns raw defaults without channel metadata",
      savedDefaults.status === 0 && savedDefaults.stderr === ""
        && JSON.stringify(registryOf(savedDefaults)) === JSON.stringify({ defaults: full?.defaults }), shown(savedDefaults));
    const named = await json("show", "__proto__");
    const missing = await json("show", "constructor");
    check("channel show JSON returns only the named saved entry and raw defaults",
      named.status === 0 && JSON.stringify(registryOf(named)?.channels) === '{"__proto__":{"description":"Operations"}}'
        && JSON.stringify(registryOf(named)?.defaults) === JSON.stringify(full?.defaults), shown(named));
    check("channel show JSON for an unsaved name keeps the defaults and returns an empty channel map",
      missing.status === 0 && JSON.stringify(registryOf(missing)?.channels) === "{}"
        && JSON.stringify(registryOf(missing)?.defaults) === JSON.stringify(full?.defaults), shown(missing));

    const nc = await connect({ servers: openServers });
    const badKeys = [CHANNEL_DEFAULTS_KEY, "bad.target", "bad.other"];
    try {
      const kv = await openChannelRegistry(nc, registrySpace);
      for (const key of badKeys) await kv.put(key, new TextEncoder().encode("[]"));
    } finally { await nc.close(); }
    const bad = await json("show", "bad.target");
    const badList = await json();
    const entries = registryOf(badList)?.undecodable;
    check("control: channel inventory JSON reports all undecodable registry keys",
      badList.status === 0 && entries?.length === 3 && badKeys.every((key) => entries.some((entry) => entry.key === key)), shown(badList));
    check("channel show JSON keeps decode errors for the requested channel and defaults only",
      bad.status === 0 && registryOf(bad)?.defaults === undefined && JSON.stringify(registryOf(bad)?.channels) === "{}"
        && JSON.stringify(registryOf(bad)?.undecodable) === JSON.stringify(entries?.filter(({ key }) => key !== "bad.other")), shown(bad));
    const badDefaults = await json("defaults");
    check("channel defaults JSON keeps only the defaults-key decode error",
      badDefaults.status === 0 && badDefaults.stderr === ""
        && JSON.stringify(registryOf(badDefaults)) === JSON.stringify({ undecodable: entries?.filter(({ key }) => key === CHANNEL_DEFAULTS_KEY) }), shown(badDefaults));
  }

  {
    const target = ["--space", openSpace, "--server", openServers, "--json"];
    const description = "Output contract test";
    const typo = await run(["channel", "set", "results", "--description", description, ...target]);
    const unsupported = await run(["channel", "set", "results", "--mystery-option", ...target]);
    const retry = await run(["channel", "set", "results", "--desc", description, ...target]);
    const readback = await run(["channel", "show", "results", ...target]);
    const result = readback.envelope?.result as { registry?: ChannelRegistryRead } | undefined;
    check("channel set with a name suggests --desc for --description, not another operand",
      typo.status === 1 && typo.stderr === "" && typo.envelope?.outcome === "refused"
        && typo.envelope.error?.code === "USAGE_INVALID" && typo.envelope.error.remedy === "use --desc"
        && unsupported.status === 1 && unsupported.envelope?.error?.remedy === "drop the unknown option"
        && retry.status === 0 && retry.envelope?.outcome === "ok" && readback.status === 0
        && result?.registry?.channels?.results?.description === description,
      { typo: shown(typo), unsupported: shown(unsupported), retry: shown(retry), readback: shown(readback) });
  }

  {
    const saved = await run(["channel", "set", "wire.window", "--window", " 24h ", "--space", openSpace, "--json"]);
    const readback = await run(["channel", "show", "wire.window", "--space", openSpace, "--json"]);
    const patch = (saved.envelope?.result as unknown as { patch?: { replayWindow?: string } })?.patch;
    const registry = (readback.envelope?.result as unknown as { registry?: { channels?: Record<string, { replayWindow?: string }> } })?.registry;
    check("channel set trims the replay window in the receipt and the saved open-space registry",
      saved.status === 0 && patch?.replayWindow === "24h" && readback.status === 0 && registry?.channels?.["wire.window"]?.replayWindow === "24h",
      { saved: shown(saved), readback: shown(readback) });
  }

  await checkChannelReplayRetry();

  // Empty wire IDs are independent deliveries, including after a retained snapshot.
  {
    const nc = await connect({ servers: openServers });
    const publish = async (id: string, text: string) => {
      nc.publish(`cotal.${openSpace}.chat.local.publisher.audit`, JSON.stringify({
        id, ts: Date.now(), space: openSpace, from: { id: "local.publisher", name: "publisher" },
        channel: "audit", parts: [{ kind: "text", text }],
      }));
      await nc.flush();
    };
    const consoleFeed = follow(["console", "--plain", "--space", openSpace]);
    let historyFeed: ReturnType<typeof follow> | undefined;
    try {
      check("empty IDs: console is watching", await consoleFeed.until((line) => line.includes("watching space")), consoleFeed.stderr());
      await publish("", "empty-first");
      await publish("", "empty-second");
      await publish("unique-third", "nonempty-third");
      check("console shows both empty-ID deliveries", await consoleFeed.until((line) => line.includes("empty-second")) && consoleFeed.lines.some((line) => line.includes("empty-first")), consoleFeed.lines);
      historyFeed = follow(["history", "audit", "--follow", "--json", "--space", openSpace]);
      check("empty IDs: follow snapshot contains both retained deliveries", await historyFeed.until((line) => line.includes('"type":"snapshot"') && line.includes("empty-first") && line.includes("empty-second")), historyFeed.lines);
      await publish("", "follow-empty-first");
      await publish("", "follow-empty-second");
      await publish("unique-fourth", "follow-nonempty");
      await publish("unique-fourth", "duplicate-nonempty");
      check("history follow shows consecutive empty-ID events after snapshot", await historyFeed.until((line) => line.includes('"type":"event"') && line.includes("follow-empty-second")) && historyFeed.lines.some((line) => line.includes('"type":"event"') && line.includes("follow-empty-first")), historyFeed.lines);
      check("nonempty follow ID still deduplicates", await historyFeed.until((line) => line.includes("follow-nonempty")), historyFeed.lines);
      await wait(300);
      check("duplicate nonempty ID is not surfaced", !historyFeed.lines.some((line) => line.includes("duplicate-nonempty")) && !consoleFeed.lines.some((line) => line.includes("duplicate-nonempty")), { history: historyFeed.lines, console: consoleFeed.lines });
      await killAndAwaitExit(consoleFeed.child, "SIGINT");
      check("stopping the open mesh console exits 130 without reporting a broker outage",
        await consoleFeed.exited === 130 && !/was lost|re-establishing/.test(consoleFeed.stderr()), consoleFeed.stderr());
      const limits = await run(["history", "limit", "--plain", "--space", openSpace]);
      check("the open broker still answers after the console stops", limits.status === 0 && limits.stdout.includes("History limits"), shown(limits));
    } finally {
      await killAndAwaitExit(consoleFeed.child);
      if (historyFeed) await killAndAwaitExit(historyFeed.child);
      await nc.close();
    }
  }

  // ── channel members on an open mesh, which runs no delivery service to write the feed ─────────
  {
    const openCard = await run(["channel", "show", "general", "--space", openSpace, "--plain"]);
    check("channel show explains unavailable membership on an open mesh and still suggests history",
      openCard.status === 0 && openCard.stdout.includes("Broker-observed channel membership is unavailable on open meshes.")
      && !openCard.stdout.includes("cotal ch members") && openCard.stdout.includes(`cotal history ${quotedChannel("general")}`), shown(openCard));
    const authCard = await run(["channel", "show", "general", "--space", space, "--plain"]);
    check("channel show still suggests membership on the auth mesh",
      authCard.status === 0 && authCard.stdout.includes("cotal ch members general"), shown(authCard));
    const selectedRoster = await run(["who", "--json"]);
    check("the default roster targets the selected static-auth space", selectedRoster.status === 0 && spaceOf(selectedRoster) === space, shown(selectedRoster));
    for (const serverFlags of [[], ["--server", openServers]]) {
      const members = await run(["channel", "members", "general", "--space", openSpace, ...serverFlags, "--json"]);
      const argv = ["who", "--space", openSpace, ...serverFlags];
      const roster = members.envelope?.error?.remedy?.startsWith(`\`cotal ${argv.join(" ")}\` lists who is present`)
        ? await run([...argv, "--json"]) : undefined;
      check(`an open membership refusal keeps the space${serverFlags.length ? " and explicit broker" : ""} in the roster command`,
        members.status === 2 && members.envelope?.outcome === "refused" && members.envelope.error?.code === "UNSUPPORTED"
          && roster?.status === 0 && spaceOf(roster) === openSpace, { refused: shown(members), roster: roster && shown(roster) });
    }
    await checkMembershipSetupRefusal(openSpace, "general", "UNSUPPORTED");
    const authMembers = await run(["channel", "members", "general", "--space", space, "--json"]);
    check("on the auth mesh it still reads the feed", authMembers.envelope?.command === "channel" && authMembers.envelope?.error?.code !== "UNSUPPORTED", shown(authMembers));
  }

  // The registry bucket is already gone. Retained chat still makes this a channel the space has,
  // so remove used to report an unconfirmed change instead of the no-op a missing entry is.
  {
    const posted = await run(["send", "-c", "bucketgone", "kept", "--space", space]);
    const teardown = await mintCreds(auth, newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid() });
    const nc = await dialerFor(servers)({ servers, ...standaloneConnectOpts({ creds: teardown, tls: false }), maxReconnectAttempts: 0 });
    let deleted = false;
    try {
      const jsm = await jetstreamManager(nc);
      const bucket = channelBucket(space);
      for await (const name of jsm.streams.names()) {
        if (!name.includes(bucket)) continue;
        await jsm.streams.delete(name);
        deleted = true;
      }
    } finally {
      await nc.close();
    }
    const gone = await run(["channel", "remove", "bucketgone", "--yes", "--space", space, "--json"]);
    const removed = (gone.envelope?.result as { removed?: boolean } | null | undefined)?.removed;
    check("removing a channel whose registry bucket is gone is a no-op, not an unconfirmed change",
      posted.status === 0 && deleted && gone.status === 0 && gone.envelope?.outcome === "no-op" && removed === false, { posted: shown(posted), gone: shown(gone), deleted });
  }
  await seedChannelRegistry({ servers, space, creds: provisionerCreds, file: { channels: { general: { replay: true, replayWindow: "24h" } } } });

  // Only the chat stream is gone. Channel history cannot be read. A stored DM must still come back,
  // and the refusal that says to create every stream again, empty, would delete it. The clear above
  // purged the earlier note, so this cell stores a new one first.
  {
    const keptNote = `dm-after-clear-${randomUUID().slice(0, 8)}`;
    await alice.unicast(`${bob.principal.owner}.${bob.principal.actor}`, keptNote);
    await wait(400);
    const teardownCreds = await mintCreds(auth, newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid() });
    const nc = await connect({
      servers,
      authenticator: credsAuthenticator(new TextEncoder().encode(teardownCreds)),
      inboxPrefix: `_INBOX_${idFromCreds(teardownCreds)}`,
      maxReconnectAttempts: 0,
    });
    try {
      await (await jetstreamManager(nc)).streams.delete(chatStream(space));
    } finally {
      await nc.close();
    }
    const kept = await run(["history", "--dms", "--json"]);
    const keptText = `${kept.stdout}${kept.stderr}`;
    check(
      "history --dms returns a stored DM when only the chat stream is gone, and does not say to create every stream again",
      kept.status === 4 && kept.envelope?.outcome === "partial" && kept.envelope.warnings.some((w) => w.code === "CHAT_STREAM_ABSENT") && (kept.envelope.result?.items ?? []).some((i) => i.text === keptNote && i.channel === null) && !keptText.includes("create them again"),
      shown(kept),
    );
    const channelGone = await run(["history", "general", "--json"]);
    check(
      "channel history still refuses TARGET_UNAVAILABLE when the chat stream is gone",
      channelGone.status === 2 && channelGone.envelope?.error?.code === "TARGET_UNAVAILABLE" && channelGone.envelope.error.message?.startsWith(`the streams of ${space} are not on its broker`) === true,
      shown(channelGone),
    );
  }
  // Restore the chat stream removed above so this cell owns its deletion.
  // Purging a saved channel must still remove the entry when that stream is gone.
  {
    await setupSpaceStreams({ servers, space, creds: provisionerCreds });
    const set = await run(["channel", "set", "ops", "--desc", "purge-gone", "--space", space, "--json"]);
    const teardownCreds = await mintCreds(auth, newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid() });
    const nc = await connect({
      servers,
      authenticator: credsAuthenticator(new TextEncoder().encode(teardownCreds)),
      inboxPrefix: `_INBOX_${idFromCreds(teardownCreds)}`,
      maxReconnectAttempts: 0,
    });
    try { await (await jetstreamManager(nc)).streams.delete(chatStream(space)); }
    finally { await nc.close(); }
    const removed = await run(["channel", "remove", "ops", "--purge", "--yes", "--space", space, "--json"]);
    const show = await run(["channel", "show", "ops", "--space", space, "--json"]);
    const channels = (show.envelope?.result as { registry?: { channels?: Record<string, unknown> } } | null)?.registry?.channels;
    const receipt = removed.envelope?.result as { removed?: boolean; purged?: number } | null;
    check("channel remove --purge removes the saved entry when the chat stream is already gone",
      set.status === 0 && removed.status === 0 && removed.envelope?.outcome === "ok" && receipt?.removed === true && receipt.purged === 0 && channels?.ops === undefined,
      { set: shown(set), removed: shown(removed), show: shown(show) });
  }

  // Start with one stored DM, independent of earlier reads and clears.
  // clean history must purge it even when the chat stream is gone.
  {
    await setupSpaceStreams({ servers, space, creds: provisionerCreds });
    const purgerCreds = await mintCreds(auth, newIdentity(), "purger");
    const teardownCreds = await mintCreds(auth, newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid() });
    const nc = await connect({
      servers,
      authenticator: credsAuthenticator(new TextEncoder().encode(purgerCreds)),
      inboxPrefix: `_INBOX_${idFromCreds(purgerCreds)}`,
      maxReconnectAttempts: 0,
    });
    try { await (await jetstreamManager(nc)).streams.purge(dmStream(space)); }
    finally { await nc.close(); }
    const note = `clean-dm-${randomUUID().slice(0, 8)}`;
    await alice.unicast(`${bob.principal.owner}.${bob.principal.actor}`, note);
    await wait(400);
    const drop = await connect({
      servers,
      authenticator: credsAuthenticator(new TextEncoder().encode(teardownCreds)),
      inboxPrefix: `_INBOX_${idFromCreds(teardownCreds)}`,
      maxReconnectAttempts: 0,
    });
    try { await (await jetstreamManager(drop)).streams.delete(chatStream(space)); }
    finally { await drop.close(); }
    const cleared = await run(["clean", "history", "--force", "--dms"]);
    const read = await connect({
      servers,
      authenticator: credsAuthenticator(new TextEncoder().encode(teardownCreds)),
      inboxPrefix: `_INBOX_${idFromCreds(teardownCreds)}`,
      maxReconnectAttempts: 0,
    });
    let dmLeft = -1;
    try { dmLeft = (await (await jetstreamManager(read)).streams.info(dmStream(space))).state.messages; }
    finally { await read.close(); }
    check("clean history purges direct messages when the chat stream is already gone",
      cleared.status === 0 && cleared.stdout.includes("cleared 0 channel messages") && /1 DM message/.test(cleared.stdout) && dmLeft === 0,
      { cleared: shown(cleared), dmLeft });
  }

  // Restore streams and store what this clear needs before deleting either stream.
  {
    await setupSpaceStreams({ servers, space, creds: provisionerCreds });
    const note = `clear-dm-${randomUUID().slice(0, 8)}`;
    await alice.unicast(`${bob.principal.owner}.${bob.principal.actor}`, note);
    await wait(400);
    const teardownCreds = await mintCreds(auth, newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid() });
    const open = async () => connect({
      servers,
      authenticator: credsAuthenticator(new TextEncoder().encode(teardownCreds)),
      inboxPrefix: `_INBOX_${idFromCreds(teardownCreds)}`,
      maxReconnectAttempts: 0,
    });
    const messages = async (name: string) => {
      const nc = await open();
      try { return (await (await jetstreamManager(nc)).streams.info(name)).state.messages; }
      finally { await nc.close(); }
    };
    const drop = async (name: string) => {
      const nc = await open();
      try { await (await jetstreamManager(nc)).streams.delete(name); }
      finally { await nc.close(); }
    };
    const before = await messages(dmStream(space));
    await drop(chatStream(space));
    const chatOnly = await run(["history", "clear", "--yes", "--json"]);
    const dmKept = await messages(dmStream(space));
    check("history clear with only the chat stream gone is a no-op and leaves direct messages",
      chatOnly.status === 0 && chatOnly.envelope?.outcome === "no-op" && chatOnly.envelope.warnings.some((w) => w.code === "HISTORY_STREAM_ABSENT" && w.message.includes(chatStream(space))) && before > 0 && dmKept === before,
      { chatOnly: shown(chatOnly), before, dmKept });
    const cleared = await run(["history", "clear", "--yes", "--dms", "--json"]);
    const dmAfter = await messages(dmStream(space));
    const acked = (cleared.envelope?.result as { acknowledged?: { stream: string; purged: number }[] } | null)?.acknowledged ?? [];
    check("history clear --dms purges the direct messages when the chat stream is gone and names that stream",
      cleared.status === 0 && cleared.envelope?.outcome === "ok" && cleared.envelope.warnings.some((w) => w.code === "HISTORY_STREAM_ABSENT" && w.message.includes(chatStream(space))) && dmAfter === 0 && acked.some((row) => row.stream === dmStream(space) && row.purged === before),
      { cleared: shown(cleared), before, dmAfter });
    await drop(dmStream(space));
    const none = await run(["history", "clear", "--yes", "--dms", "--json"]);
    check("history clear --dms is a no-op when the chat and direct-message streams are both gone",
      none.status === 0 && none.envelope?.outcome === "no-op" && none.envelope.warnings.some((w) => w.code === "HISTORY_STREAM_ABSENT" && w.message.includes(chatStream(space)) && w.message.includes(dmStream(space))),
      shown(none));
  }

  // All cells needing stored DMs have finished. Restore both streams for the inverse absence case.
  {
    await setupSpaceStreams({ servers, space, creds: provisionerCreds });
    const keptNote = `dm-stream-${randomUUID().slice(0, 8)}`;
    await alice.multicast("channel stays", { channel: "general" });
    await alice.unicast(`${bob.principal.owner}.${bob.principal.actor}`, keptNote);
    await wait(400);
    const teardownCreds = await mintCreds(auth, newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid() });
    const nc = await connect({
      servers,
      authenticator: credsAuthenticator(new TextEncoder().encode(teardownCreds)),
      inboxPrefix: `_INBOX_${idFromCreds(teardownCreds)}`,
      maxReconnectAttempts: 0,
    });
    try { await (await jetstreamManager(nc)).streams.delete(dmStream(space)); }
    finally { await nc.close(); }
    const kept = await run(["history", "--dms", "--json"]);
    const items = kept.envelope?.result?.items ?? [];
    check(
      "history --dms is partial when only the direct-message stream is gone, and channel history remains",
      kept.status === 4 && kept.envelope?.outcome === "partial" && kept.envelope.warnings.some((w) => w.code === "DM_STREAM_ABSENT") && items.some((i) => i.text === "channel stays" && i.channel === "general") && !items.some((i) => i.text === keptNote),
      shown(kept),
    );
    const general = await run(["history", "general", "--json"]);
    check(
      "channel history stays complete when only the direct-message stream is gone",
      general.status === 0 && general.envelope?.completeness === "complete" && (general.envelope?.result?.items ?? []).some((i) => i.text === "channel stays"),
      shown(general),
    );
  }

  // Keep the same follower and broker store across a short restart of a live channel.
  for (const ep of endpoints) await ep.stop();
  await provisioner.stop();
  const publisher = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "operator"),
    card: { name: "restart-publisher", kind: "endpoint" }, consume: false, watchPresence: false, watchChannels: false, registerPresence: false });
  publisher.on("error", () => {});
  const liveChannel = await run(["channel", "set", "updates", "--delivery", "live", "--no-replay", "--json"]);
  check("restart control: live channel saved", liveChannel.status === 0, shown(liveChannel));
  const restarted = follow(["history", "updates", "--follow", "--json"]);
  let replacement: ReturnType<typeof spawn> | undefined;
  let releaseReplacement: (() => void) | undefined;
  try {
    const snap = await restarted.until((line) => line.includes('"type":"snapshot"'));
    await killAndAwaitExit(broker);
    await wait(2_000);
    replacement = spawn("nats-server", ["-c", join(storeDir, "server.conf")], { stdio: "ignore" });
    releaseReplacement = teardownOnSignal(replacement, storeDir);
    await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
    const gap = await restarted.until((line) => line.includes('"type":"gap"'), 10_000);
    await publisher.start();
    const text = "post after broker restart";
    await publisher.multicast(text, { channel: "updates" });
    const event = await restarted.until((line) => line.includes(`"text":"${text}"`));
    const seen = restarted.lines.map((line) => JSON.parse(line) as { type: string; data: { code?: string; text?: string } });
    check("a short broker restart reports one loss and one gap before resuming live history",
      snap && gap && event && seen.map((row) => row.type).join() === "snapshot,error,gap,event"
        && seen[1]?.data.code === "TARGET_UNAVAILABLE" && seen[3]?.data.text === text,
      { lines: restarted.lines, stderr: restarted.stderr() });
  } finally {
    await killAndAwaitExit(restarted.child, "SIGINT");
    await publisher.stop().catch(() => {});
    if (replacement) await killAndAwaitExit(replacement);
    releaseReplacement?.();
  }
  const stoppedRead = await run(["history", "updates", "--space", space, "--server", servers, "--json"]);
  const stoppedFollow = await run(["history", "updates", "--space", space, "--server", servers, "--follow", "--json"]);
  const stoppedRecords = stoppedFollow.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    stream?: string; type?: string; schemaVersion?: number; data?: { code?: string; message?: string; remedy?: string; reason?: string };
  });
  const stoppedError = stoppedRead.envelope?.error;
  check("a follow that cannot start writes the finite refusal as a history error followed by end",
    stoppedRead.status === 2 && stoppedError?.code === "TARGET_UNAVAILABLE" && Boolean(stoppedError.remedy)
      && stoppedFollow.status === 2 && stoppedRecords.map((r) => r.type).join() === "error,end"
      && stoppedRecords.every((r) => r.schemaVersion === 1 && r.stream === "history")
      && stoppedRecords[0]?.data?.code === stoppedError.code && stoppedRecords[0]?.data?.message === stoppedError.message
      && stoppedRecords[0]?.data?.remedy === stoppedError.remedy && stoppedRecords[1]?.data?.reason === "setup-failed",
    { read: shown(stoppedRead), follow: shown(stoppedFollow) });
  await checkMembershipSetupRefusal(space, "updates", "TARGET_UNAVAILABLE", "--server", servers);
  await checkEventShapedChannelHistory();
  await checkGreekSigmaHistory();
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
