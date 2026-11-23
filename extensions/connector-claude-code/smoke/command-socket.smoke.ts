/*
 * The seat's command socket with the real reader. This suite opens the feed with its own pid as the
 * Claude pid and spawns the built `dist/command-reader.cjs` as its child, so the reader's
 * `process.ppid` names the same sockets, as it does under Claude Code. The reader says hello, the
 * feed is acknowledged, requests reach the reader's stdout with their `route`, and answers sent
 * through `answer <route>` resolve them. Refusals (an old Claude, version skew) carry their causes,
 * and a reader that goes away rejects what it left unanswered. A feed that streams asks each reader
 * it accepts for the session's reply text, and takes `deltas` only under the id it sent the current
 * reader.
 *
 * Run: pnpm smoke:claude-command-socket
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/command-socket.json
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import { CONNECTOR_VERSION } from "@cotal-ai/connector-core/version";
import { commandSocketPath, openCommandFeed, type CommandFeed } from "../src/command-feed.js";
import { MAX_REQUEST_BYTES, type ModAnswer } from "../src/command-frames.js";

const READER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "command-reader.cjs");
const scratch = mkdtempSync(join(tmpdir(), "cmd-sock-"));
process.env.TMPDIR = scratch;
const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, LANG: "C.UTF-8" };
const { check, finish } = createSuite();
const children = new Set<ChildProcess>();
const warnings: string[] = [];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Whether `p` settles within `ms`, so a broken rule fails its cell instead of stalling the suite. */
const within = (p: Promise<unknown>, ms = 5_000) => Promise.race([p.then(() => true), wait(ms).then(() => false)]);

async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (cond()) return true;
  return cond();
}

/** The real reader, a child of this process, with its stdout read line by line. */
function startReader(claude: string) {
  const child = spawn(process.execPath, [READER, "read", "--claude", claude], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const lines: Record<string, unknown>[] = [];
  let stderr = "";
  createInterface({ input: child.stdout! }).on("line", (l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const next = async () => ((await until(() => lines.length > 0)) ? lines.shift()! : undefined);
  return { child, next, stderr: () => stderr };
}

function answer(route: string, frame: unknown): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [READER, "answer", route], { env, stdio: ["pipe", "ignore", "ignore"] });
    children.add(child);
    child.on("close", (code) => resolve(code));
    // A helper that refuses its route exits before it reads stdin.
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify(frame));
  });
}

/** Connect as a hand-written reader and send `hello`; resolves with the first line the server writes. */
function rawHello(path: string, hello: unknown): Promise<{ socket: Socket; reply: string; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(hello)}\n`));
    socket.on("data", (d: string) => {
      reply += d;
      if (reply.includes("\n")) resolve({ socket, reply: reply.slice(0, reply.indexOf("\n")), closed });
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("the server closed the connection without a reply")));
  });
}

function settle<T>(p: Promise<T>): { state: () => "pending" | "resolved" | "rejected"; value: () => T | undefined; error: () => Error | undefined } {
  let state: "pending" | "resolved" | "rejected" = "pending";
  let value: T | undefined;
  let error: Error | undefined;
  p.then((v) => ((state = "resolved"), (value = v)), (e: Error) => ((state = "rejected"), (error = e)));
  return { state: () => state, value: () => value, error: () => error };
}

async function staleSocket(): Promise<void> {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const stale = commandSocketPath(process.pid, dead);
  writeFileSync(stale, "");
  const feed = await openCommandFeed(process.pid, { warn: () => {} });
  check("opening removes a socket whose server has exited", !existsSync(stale));
  feed.close();
}

async function noReader(feed: CommandFeed, path: string): Promise<void> {
  check("the socket file is 0600", (statSync(path).mode & 0o777) === 0o600, (statSync(path).mode & 0o777).toString(8));
  check("the socket directory is 0700", (statSync(dirname(path)).mode & 0o777) === 0o700);
  check("with no reader the feed names the missing mod", /^the command mod is not running in this Claude Code session/.test(feed.unsupported() ?? ""), feed.unsupported());
  const p = settle(feed.request({ op: "list" }));
  await wait(20);
  check("a request with no reader rejects at once with that cause", p.state() === "rejected" && p.error()?.message === feed.unsupported(), p.error()?.message);
}

async function served(feed: CommandFeed, path: string): Promise<void> {
  const reader = startReader("2.1.330");
  check("the real reader's hello is acknowledged", await until(() => feed.unsupported() === undefined), feed.unsupported());
  const list = settle(feed.request({ op: "list" }));
  const req = await reader.next();
  check("the reader prints the request with its route", req?.op === "list" && req.route === path && /^[a-z2-7]{26}$/.test(String(req.id)), req);
  const listAnswer: ModAnswer = { id: String(req?.id), op: "list", commands: [{ name: "deploy", description: "Ship it" }] };
  check("the answer helper exits 0 on the server's ok", (await answer(path, listAnswer)) === 0);
  check("the list request resolves with the mod's answer", (await until(() => list.state() !== "pending")) && JSON.stringify(list.value()) === JSON.stringify(listAnswer), list.value() ?? list.error()?.message);

  const run = settle(feed.request({ op: "run", command: "deploy", args: "prod --dry" }));
  const runReq = await reader.next();
  check("a run request carries its command and args", runReq?.command === "deploy" && runReq.args === "prod --dry", runReq);
  check("a list answer to a run request is refused", (await answer(path, { ...listAnswer, id: runReq?.id })) === 1);
  check("an answer to an unknown request is refused", (await answer(path, { id: "a".repeat(26), op: "run", outcome: "started" })) === 1);
  // A listening socket that takes anything: only the route check keeps the helper off it.
  const decoy = createServer((s) => s.end("ok\n")).listen(join(scratch, "decoy.sock"));
  await new Promise((resolve) => decoy.once("listening", resolve));
  check("the answer helper refuses a route that is not this session's", (await answer(join(scratch, "decoy.sock"), { id: runReq?.id, op: "run", outcome: "started" })) === 1);
  decoy.close();
  check("the answer helper refuses to send a hello, which would replace the reader", (await answer(path, { op: "hello", mod: CONNECTOR_VERSION, claude: "2.1.330" })) === 1 && run.state() === "pending" && feed.unsupported() === undefined, run.error()?.message);
  check("an error answer settles a run request", (await answer(path, { id: runReq?.id, op: "error", reason: "the mod failed" })) === 0 && (await until(() => run.state() === "resolved")) && run.value()?.op === "error");
  check("the server warned about each refused answer", warnings.some((w) => /a list answer to a run request/.test(w)) && warnings.some((w) => /unknown request/.test(w)), warnings);

  // The longest turn text, every character one that JSON escapes to six bytes: over the 1 MiB an
  // answer may take, under the request limit.
  const longest = "\u0001".repeat(262144);
  const prompt = settle(feed.request({ op: "prompt", text: longest }));
  const promptReq = await reader.next();
  check("a prompt of the longest turn text reaches the reader whole", promptReq?.op === "prompt" && promptReq.text === longest, String(promptReq?.op));
  check("...and its answer settles it", (await answer(path, { id: promptReq?.id, op: "prompt", outcome: "submitted" })) === 0 && (await until(() => prompt.state() === "resolved")));
  const over = settle(feed.request({ op: "prompt", text: "x".repeat(MAX_REQUEST_BYTES) }));
  check("a request over the limit rejects at once, unsent", (await until(() => over.state() === "rejected")) && /over 2097152 bytes/.test(over.error()?.message ?? "") && feed.unsupported() === undefined, over.error()?.message);

  const interrupt = settle(feed.request({ op: "interrupt" }));
  check("the reader got the interrupt request", (await reader.next())?.op === "interrupt");
  reader.child.kill("SIGTERM");
  check("a reader that disconnects rejects its pending request", (await until(() => interrupt.state() === "rejected")) && /reader disconnected/.test(interrupt.error()?.message ?? ""), interrupt.error()?.message);
  check("with its reader gone the feed names the missing mod again", /^the command mod is not running/.test(feed.unsupported() ?? ""), feed.unsupported());
}

/** The stream request, and the reply text answered under it. */
async function streaming(feed: CommandFeed, path: string): Promise<void> {
  const got: unknown[] = [];
  const first = startReader("2.1.330");
  await until(() => feed.unsupported() === undefined);
  feed.stream((deltas) => got.push(...deltas));
  const ask = await first.next();
  check("a feed that streams asks its reader for the reply text", ask?.op === "stream" && ask.route === path && /^[a-z2-7]{26}$/.test(String(ask.id)), ask);
  const delta = { key: "stream:4b5c1a7e-1f0e-4f4e-9c55-6f0bb2f1a001:1", text: "one\n" };
  check("reply text under that id reaches the sink, and the helper exits 0",
    (await answer(path, { id: ask?.id, op: "deltas", deltas: [delta] })) === 0 && JSON.stringify(got) === JSON.stringify([delta]), got);
  const second = startReader("2.1.330");
  const again = await second.next();
  check("a reader that replaces it is asked under a new id", again?.op === "stream" && again.id !== ask?.id, again);
  check("reply text under the replaced reader's id is refused, and the sink gets nothing more",
    (await answer(path, { id: ask?.id, op: "deltas", deltas: [delta] })) === 1 && got.length === 1, got);
  first.child.kill("SIGTERM");
  second.child.kill("SIGTERM");
  await until(() => feed.unsupported() !== undefined);
}

async function refusals(feed: CommandFeed, path: string): Promise<void> {
  const old = startReader("2.1.329");
  check("an old Claude is refused with its cause", await until(() => feed.unsupported() === "Claude Code 2.1.329 is older than 2.1.330"), feed.unsupported());
  check("the refused reader reports the refusal", await until(() => /refused this reader: Claude Code 2\.1\.329 is older/.test(old.stderr())), old.stderr());
  await wait(1_500);
  const told = old.stderr().match(/refused this reader/g)?.length;
  check("a refused reader does not say hello again", told === 1, old.stderr());
  old.child.kill("SIGTERM");

  const skew = await rawHello(path, { op: "hello", mod: "0.0.1", claude: "2.1.400" });
  const cause = `the mod is 0.0.1 and the server is ${CONNECTOR_VERSION}; reload the plugin or restart the session`;
  check("a reader of another version is refused with its cause", JSON.stringify(JSON.parse(skew.reply)) === JSON.stringify({ op: "refused", reason: cause }), skew.reply);
  check("the server ends a refused reader's connection", await within(skew.closed));
  check("the skew cause stays until a later hello is accepted", feed.unsupported() === cause, feed.unsupported());

  const first = await rawHello(path, { op: "hello", mod: CONNECTOR_VERSION, claude: "2.1.400" });
  check("a later hello is accepted", first.reply === '{"op":"ready"}' && feed.unsupported() === undefined, first.reply);
  const pending = settle(feed.request({ op: "list" }));
  const second = await rawHello(path, { op: "hello", mod: CONNECTOR_VERSION, claude: "2.1.400" });
  check("a new hello replaces the earlier reader and rejects its requests", second.reply === '{"op":"ready"}' && (await within(first.closed)) && (await until(() => pending.state() === "rejected")) && /replaced/.test(pending.error()?.message ?? ""), pending.error()?.message);

  const malformed = await rawHello(path, { op: "hello", mod: CONNECTOR_VERSION }).catch(() => undefined);
  check("a malformed frame closes its connection with a warning", malformed === undefined && warnings.some((w) => /claude does not match/.test(w)), warnings.at(-1));

  const left = settle(feed.request({ op: "interrupt" }));
  feed.close();
  check("closing rejects the requests still waiting", (await until(() => left.state() === "rejected")) && /feed closed/.test(left.error()?.message ?? ""), left.error()?.message);
  check("closing removes the socket file", await until(() => !existsSync(path)));
  check("closing ends the reader's connection", await within(second.closed));
}

try {
  await staleSocket();
  const feed = await openCommandFeed(process.pid, { warn: (msg) => warnings.push(msg) });
  const path = commandSocketPath(process.pid);
  await noReader(feed, path);
  await served(feed, path);
  await streaming(feed, path);
  await refusals(feed, path);
  console.log("command-socket.smoke: done");
} catch (e) {
  check("the suite ran to its end", false, (e as Error).stack);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
  finish();
  process.exit();
}
