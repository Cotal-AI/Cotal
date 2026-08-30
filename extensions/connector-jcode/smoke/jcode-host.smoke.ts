import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CotalEndpoint, isReachable, seedChannelRegistry } from "@cotal-ai/core";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor<T>(name: string, read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
    await sleep(100);
  }
}

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-host-"));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const shimDir = join(root, "bin");
const shim = join(shimDir, "jcode");
const log = join(root, "fake.jsonl");
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
const hosts: ChildProcess[] = [];

function spawnHost(opts: SpawnOptions): ChildProcess {
  const proc = spawn(tsx, [host], { ...opts, detached: true });
  hosts.push(proc);
  return proc;
}

function groupAlive(proc: ChildProcess): boolean {
  if (proc.pid === undefined) return false;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopHostTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const leaderAlive = (): boolean => proc.exitCode === null && proc.signalCode === null;
  if (signal === "SIGTERM" && leaderAlive()) {
    // Grace belongs to the host leader. Signalling its whole group here kills the fake bridge before
    // the host can retire it and turns a clean shutdown into a restart race.
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  } else if (proc.pid !== undefined && groupAlive(proc)) {
    try { process.kill(-proc.pid, signal); } catch { /* already gone */ }
  } else if (leaderAlive()) {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
  // The host's own shutdown can spend 3s gracefully stopping the bridge, 2s escalating it, then
  // repeat that budget for descendants before its quiescence window and mesh close. The outer
  // harness must outlive that whole path before it decides the leader is wedged.
  const leaderDeadline = Date.now() + 15_000;
  while (leaderAlive() && Date.now() < leaderDeadline) await sleep(50);
  // Whether the leader exited cleanly or was already gone, the process group may still contain a
  // reparented api-bridge. The group is the ownership unit and is never allowed past this helper.
  if (groupAlive(proc) && proc.pid !== undefined) {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  for (let i = 0; i < 100 && (leaderAlive() || groupAlive(proc)); i++) await sleep(50);
  proc.stdin?.destroy();
  proc.stdout?.destroy();
  proc.stderr?.destroy();
}

let child: ChildProcess | undefined;
let outage: ChildProcess | undefined;
let outageNats: ChildProcess | undefined;
let operator: CotalEndpoint | undefined;
let outageOperator: CotalEndpoint | undefined;
let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  if (!raw.endsWith("\n")) lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line) as T);
}
const entries = (): Array<{ ev: string; [key: string]: unknown }> =>
  readJsonLines(log);

function managedHome(space: string, name: string): string {
  const slug = `${space}-${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const key = createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 12);
  return join(root, ".cotal", "jcode", `${slug || "agent"}-${key}`);
}

function connectorLog(home: string): string {
  const logs = join(home, "logs");
  const files = readdirSync(logs).filter((file) => /^connector-.*\.log$/.test(file));
  assert.equal(files.length, 1, `expected one connector log in ${logs}, found ${files.join(", ")}`);
  return readFileSync(join(logs, files[0]!), "utf8");
}

type JcodeMcpEntry = { command: string; args: string[]; env: Record<string, string> };

function jcodeMcpEntry(home: string): JcodeMcpEntry {
  const mcp = join(home, "mcp.json");
  return (JSON.parse(readFileSync(mcp, "utf8")) as { servers: { cotal: JcodeMcpEntry } }).servers.cotal;
}

async function callJcodeMcp(
  home: string,
  socket: string,
  token: string,
  arguments_: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const entry = jcodeMcpEntry(home);
  const client = new Client({ name: "jcode-host-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    cwd: root,
    env: { ...entry.env, COTAL_JCODE_MCP_SOCKET: socket, COTAL_JCODE_MCP_TOKEN: token },
    stderr: "ignore",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "cotal_inbox", arguments: arguments_ });
    return {
      text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      isError: result.isError,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Send the generated stdio MCP command raw JSON-RPC so JSON-own prototype keys reach the server.
 * The SDK client builds a JavaScript params object first, which is not an equivalent wire probe. */
async function callJcodeMcpRaw(
  home: string,
  socket: string,
  token: string,
  argsJson: string,
): Promise<{ text: string; isError?: boolean }> {
  const entry = jcodeMcpEntry(home);
  const bridge = spawn(entry.command, entry.args, {
    cwd: root,
    // PATH only: the tsx shim needs `node`, matching StdioClientTransport. Do not copy COTAL_*.
    env: {
      ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
      ...entry.env,
      COTAL_JCODE_MCP_SOCKET: socket,
      COTAL_JCODE_MCP_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // An unread stderr pipe fills (64 KiB on Linux, smaller on macOS) and the child
  // blocks on write, so it never answers the JSON-RPC frame. Bridge stderr is
  // diagnostic only: the suite asserts on stdout frames and exit codes, so
  // discarding it here is acceptable; leaving it unread is not.
  bridge.stderr?.resume();
  let pending = "";
  const MAX_PENDING_STDOUT_BYTES = 64 * 1024;
  const garbage: string[] = [];
  type FrameWaiter = {
    resolve: (frame: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const frames = new Map<number, FrameWaiter>();
  const describeGarbage = (): string =>
    garbage.length === 0
      ? ""
      : `; child also wrote ${garbage.length} unparseable line(s), first: ${garbage[0]}`;
  const settleFrame = (id: number, fn: (waiter: FrameWaiter) => void): void => {
    const waiter = frames.get(id);
    if (!waiter) return;
    frames.delete(id);
    clearTimeout(waiter.timer);
    fn(waiter);
  };
  const rejectAll = (error: Error): void => {
    for (const id of [...frames.keys()]) settleFrame(id, (waiter) => waiter.reject(error));
  };
  bridge.stdout?.setEncoding("utf8");
  bridge.stdout?.on("data", (chunk: string) => {
    if (Buffer.byteLength(pending) + Buffer.byteLength(chunk) > MAX_PENDING_STDOUT_BYTES) {
      rejectAll(new Error(`callJcodeMcpRaw exceeded ${MAX_PENDING_STDOUT_BYTES} buffered stdout bytes without a complete response`));
      return;
    }
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (garbage.length < 5) garbage.push(line.slice(0, 200));
        continue;
      }
      if (parsed === null || typeof parsed !== "object") {
        if (garbage.length < 5) garbage.push(line.slice(0, 200));
        continue;
      }
      const frame = parsed as Record<string, unknown>;
      if (typeof frame.id !== "number" || !frames.has(frame.id)) continue;
      if (frame.jsonrpc !== "2.0" || (!Object.hasOwn(frame, "result") && !Object.hasOwn(frame, "error"))) {
        settleFrame(frame.id, (waiter) =>
          waiter.reject(new Error(`callJcodeMcpRaw received an invalid JSON-RPC response for id ${frame.id}`)),
        );
        continue;
      }
      settleFrame(frame.id, (waiter) => waiter.resolve(frame));
    }
  });
  const frameName = (id: number): string => (id === 1 ? "initialize" : id === 2 ? "tools/call" : `id ${id}`);
  bridge.once("close", (code, signal) =>
    rejectAll(new Error(`callJcodeMcpRaw child closed (code=${code} signal=${signal}) before its response${describeGarbage()}`)),
  );
  const request = (id: number, json: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => settleFrame(id, (waiter) => waiter.reject(new Error(`callJcodeMcpRaw timed out waiting for frame id ${id} (${frameName(id)})${describeGarbage()}`))),
        10_000,
      );
      frames.set(id, { resolve, reject, timer });
      bridge.stdin?.write(json + "\n");
    });

  try {
    await request(1, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"jcode-host-smoke","version":"0.0.0"}}}');
    bridge.stdin?.write('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n');
    const frame = await request(2, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cotal_inbox","arguments":${argsJson}}}`);
    const result = frame.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
    if (!result) throw new Error(`raw MCP call returned no result: ${JSON.stringify(frame)}`);
    return {
      text: result.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "",
      isError: result.isError,
    };
  } finally {
    bridge.stdin?.end();
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGTERM");
    for (let i = 0; i < 20 && bridge.exitCode === null && bridge.signalCode === null; i++) await sleep(50);
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
    for (let i = 0; i < 100 && bridge.exitCode === null && bridge.signalCode === null; i++) await sleep(50);
    bridge.stdin?.destroy();
    bridge.stdout?.destroy();
    bridge.stderr?.destroy();
  }
}

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({ servers, space: "jcodehost", file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  operator = new CotalEndpoint({ space: "jcodehost", servers, card: { name: "operator", kind: "agent", id: "operator" }, channels: ["team"] });
  operator.on("error", () => {});
  let peerId: string | undefined;
  const announced = new Set<string>();
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (event.type === "offline") return;
    announced.add(event.presence.card.name);
    if (event.presence.card.name === "jcodepeer") peerId = event.presence.card.id;
  });
  await operator.start();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  const inheritedJcodeHome = join(root, "source-jcode");
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "host-smoke-token", { mode: 0o600 });
  child = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "jcodepeer",
      COTAL_ID: "jcodepeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_QUIET: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_MODEL: "fake-model",
      COTAL_VARIANT: "high",
      COTAL_CONTROL_SOCKET: join(root, "control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-host-smoke-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  await waitFor("fake bridge", () => entries().find((entry) => entry.ev === "listening"));
  await waitFor("mesh presence", () => peerId);
  check("Jcode host joins the mesh", Boolean(peerId));
  const argv = entries().find((entry) => entry.ev === "argv") as { argv?: string[]; env?: Record<string, string> };
  check("host uses api-bridge with its private socket", argv.argv?.[0] === "api-bridge" && argv.argv?.[1] === "--api-socket", argv);
  check("host scrubs Cotal material before launching Jcode", Object.keys(argv.env ?? {}).every((key) => !key.startsWith("COTAL_")), argv.env);
  check("private JCODE_HOME is passed to the harness", Boolean(argv.env?.JCODE_HOME?.includes("/tmp/jc-") && argv.env?.JCODE_HOME?.endsWith("/home")), argv.env);
  check("host disables SDK symlinked credential inheritance", argv.env?.JCODE_HOME !== undefined && !Object.keys(argv.env ?? {}).some((key) => key === "COTAL_JCODE_HOME"), argv.env);
  // A seat that updates its own binary restarts its process tree, which drops the only connection
  // the Jcode server counts as a client; nothing re-attaches, and the server's idle reaper kills
  // the seat mid-turn five minutes later. The seat's version is fixed at spawn time.
  check("host pins the seat binary against background self-update", argv.env?.JCODE_NO_AUTO_UPDATE === "1", argv.env);
  const peerHome = managedHome("jcodehost", "jcodepeer");
  check("host copies auth mirror rather than linking it", lstatSync(join(peerHome, "auth.json")).isFile() && !lstatSync(join(peerHome, "auth.json")).isSymbolicLink());
  check("host copied auth mirror is owner-only", (statSync(join(peerHome, "auth.json")).mode & 0o777) === 0o600);

  // Jcode invokes this actual stdio MCP bridge, which relays across the live per-seat Unix socket
  // into the host's MeshAgent. A schema-valid explicit `peek:false` must not be rejected by either
  // hop: the bug was an adapter-only no-argument branch that advertised this input then refused it.
  const privateMcp = JSON.parse(readFileSync(join(peerHome, "mcp.json"), "utf8")) as {
    servers: { cotal: { env: Record<string, string> } };
  };
  const relaySocket = privateMcp.servers.cotal.env.COTAL_JCODE_MCP_SOCKET!;
  const relayToken = privateMcp.servers.cotal.env.COTAL_JCODE_MCP_TOKEN!;
  await operator.multicast("quiet buffered", { channel: "team" });
  await sleep(100);
  const peekFalse = await callJcodeMcp(peerHome, relaySocket, relayToken, {
    peek: false,
    accept_large_output: true,
    intent: "read buffered messages",
  });
  check("Jcode cotal_inbox accepts explicit peek:false and strips harness metadata through the live relay", !peekFalse.isError && peekFalse.text.includes("quiet buffered"), peekFalse);

  await operator.multicast("peek survives", { channel: "team" });
  await sleep(100);
  const peekTrue = await callJcodeMcp(peerHome, relaySocket, relayToken, { peek: true });
  check("Jcode cotal_inbox peek:true reaches the host and returns buffered traffic", !peekTrue.isError && peekTrue.text.includes("peek survives"), peekTrue);
  const afterPeek = await callJcodeMcp(peerHome, relaySocket, relayToken, {});
  check("Jcode cotal_inbox peek:true leaves the returned message for the following normal read", !afterPeek.isError && afterPeek.text.includes("peek survives"), afterPeek);
  const unknownInboxArg = await callJcodeMcp(peerHome, relaySocket, relayToken, { unknown: true });
  check("Jcode cotal_inbox still refuses unknown non-metadata arguments", unknownInboxArg.isError === true && unknownInboxArg.text.includes("unknown"), unknownInboxArg);

  // JSON.parse is required: an object-literal __proto__ is special syntax, not an own JSON key.
  // A rejected unknown argument must not fall through to the destructive default inbox read.
  await operator.multicast("prototype-key witness", { channel: "team" });
  await sleep(100);
  const protoInboxArg = await callJcodeMcpRaw(peerHome, relaySocket, relayToken, '{"__proto__":true}');
  const afterProtoInboxArg = await callJcodeMcp(peerHome, relaySocket, relayToken, {});
  check(
    "Jcode cotal_inbox refuses JSON-own __proto__ without consuming the buffered message",
    protoInboxArg.isError === true && protoInboxArg.text.includes("__proto__") &&
      !afterProtoInboxArg.isError && afterProtoInboxArg.text.includes("prototype-key witness"),
    { protoInboxArg, afterProtoInboxArg },
  );

  for (const key of ["constructor", "prototype"]) {
    const witness = `${key}-key witness`;
    await operator.multicast(witness, { channel: "team" });
    await sleep(100);
    const rejected = await callJcodeMcp(peerHome, relaySocket, relayToken, { [key]: true });
    const afterRejected = await callJcodeMcp(peerHome, relaySocket, relayToken, {});
    check(
      `Jcode cotal_inbox refuses ${key} without consuming the buffered message`,
      rejected.isError === true && rejected.text.includes(key) && !afterRejected.isError && afterRejected.text.includes(witness),
      { rejected, afterRejected },
    );
  }

  await operator.unicast(peerId!, "mesh-wake");
  const turn = await waitFor("Harness API turn", () => entries().find((entry) => entry.ev === "request" && (entry.frame as { req?: string; content?: string; no_reply?: boolean }).req === "send_message" && !(entry.frame as { no_reply?: boolean }).no_reply && String((entry.frame as { content?: string }).content).includes("mesh-wake")));
  check("mesh DM becomes a Harness API turn", JSON.stringify(turn).includes("mesh-wake"), turn);
  const bootTurns = entries().filter((entry) => entry.ev === "request" && (entry.frame as { req?: string; content?: string; no_reply?: boolean }).req === "send_message" && !(entry.frame as { no_reply?: boolean }).no_reply && String((entry.frame as { content?: string }).content).includes("cotal_orientation"));
  check("host runs the mandatory cotal MCP readiness turn before joining", bootTurns.length === 1, bootTurns);
  const joinNotice = entries().find((entry) => entry.ev === "request" && (entry.frame as { req?: string; content?: string; no_reply?: boolean }).req === "send_message" && (entry.frame as { no_reply?: boolean }).no_reply && String((entry.frame as { content?: string }).content).includes("earlier cotal_orientation result was captured before this join"));
  check("post-join context supersedes the pre-join orientation card", Boolean(joinNotice), joinNotice);
  const requests = entries().filter((entry) => entry.ev === "request");
  const effortAt = requests.findIndex((entry) => (entry.frame as { req?: string }).req === "set_reasoning_effort");
  const effortFrame = effortAt < 0 ? undefined : (requests[effortAt].frame as { effort?: string; session_id?: string });
  check("requested variant reaches the session as its reasoning effort", effortFrame?.effort === "high", effortFrame);
  check("reasoning effort is applied to the host's own session", effortFrame?.session_id === "fake-session", effortFrame);
  const firstTurnAt = requests.findIndex((entry) => (entry.frame as { req?: string; no_reply?: boolean }).req === "send_message" && !(entry.frame as { no_reply?: boolean }).no_reply);
  check("reasoning effort is set before the session's first turn", effortAt >= 0 && firstTurnAt > effortAt, { effortAt, firstTurnAt });

  await stopHostTree(child, "SIGTERM");
  check("host exits cleanly on SIGTERM", child.exitCode === 0, { code: child.exitCode, stderr });

  // #777 reproduction: Jcode can lock the first turn's tool snapshot before cotal connects. The
  // old host makes one proof turn and rejects this otherwise healthy launch before it can join.
  const raceLog = join(root, "readiness-race.jsonl");
  const race = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: raceLog,
      FAKE_JCODE_ORIENTATION_DELAY_TURNS: "1",
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "racepeer",
      COTAL_ID: "racepeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "race-control.sock"),
      COTAL_CONTROL_TOKEN: "race-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let raceErr = "";
  race.stderr?.on("data", (chunk: Buffer) => (raceErr += chunk.toString()));
  await Promise.race([once(race, "exit"), sleep(20_000)]);
  const raceEntries = readJsonLines<{ ev: string; frame?: { req?: string; content?: string; no_reply?: boolean } }>(raceLog);
  const raceTurns = raceEntries.filter((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply && String(entry.frame?.content).includes("cotal_orientation"));
  check("a first-turn MCP snapshot race recovers on one bounded retry", announced.has("racepeer") && raceTurns.length === 2, { code: race.exitCode, turns: raceTurns, stderr: raceErr });
  await stopHostTree(race, "SIGTERM");
  check("the recovered readiness launch exits cleanly", race.exitCode === 0, { code: race.exitCode, stderr: raceErr });

  // A bridge that never publishes the tool must still fail loud after the bounded retry and must
  // never advertise presence. This distinguishes the recovery from a false-online fallback.
  const absentLog = join(root, "readiness-absent.jsonl");
  const absent = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: absentLog,
      FAKE_JCODE_NEVER_ORIENTATION: "1",
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "absentpeer",
      COTAL_ID: "absentpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "absent-control.sock"),
      COTAL_CONTROL_TOKEN: "absent-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let absentErr = "";
  absent.stderr?.on("data", (chunk: Buffer) => (absentErr += chunk.toString()));
  await Promise.race([once(absent, "exit"), sleep(20_000)]);
  const absentCode = absent.exitCode;
  await stopHostTree(absent, "SIGKILL");
  const absentEntries = readJsonLines<{ ev: string; frame?: { req?: string; content?: string; no_reply?: boolean } }>(absentLog);
  const absentTurns = absentEntries.filter((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply && String(entry.frame?.content).includes("cotal_orientation"));
  check("a permanently absent cotal tool gets exactly two readiness turns", absentTurns.length === 2, absentTurns);
  check("a permanently absent cotal tool ends the launch", absentCode !== null && absentCode !== 0, { code: absentCode, stderr: absentErr });
  check("a permanently absent cotal tool never reaches the roster", !announced.has("absentpeer"), [...announced]);

  // A structured downstream effort rejection is untrusted. Before the repair, this exact canary
  // reached the external observer/UI because host-main rendered the host-composed refusal verbatim.
  const effortCanary = "JCODE-REFUSAL-CANARY-3c5e9d77-DO-NOT-PRINT";
  const acceptedLadder = "minimal, low, high";
  const refusedLog = join(root, "refused-effort.jsonl");
  const refused = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: refusedLog,
      FAKE_JCODE_REFUSE_EFFORT: "xhigh",
      FAKE_JCODE_EFFORT_ERROR: `provider rejected xhigh; accepted tiers: ${acceptedLadder}, ${effortCanary}`,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "refusedpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_MODEL: "fake-model",
      COTAL_VARIANT: "xhigh",
      COTAL_CONTROL_SOCKET: join(root, "refused-control.sock"),
      COTAL_CONTROL_TOKEN: "refused-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let refusedErr = "";
  refused.stderr?.on("data", (chunk: Buffer) => (refusedErr += chunk.toString()));
  await Promise.race([once(refused, "exit"), sleep(20_000)]);
  const refusedCode = refused.exitCode;
  await stopHostTree(refused, "SIGKILL");
  check("a tier the provider refuses ends the launch", refusedCode !== null && refusedCode !== 0, { code: refusedCode, stderr: refusedErr });
  check(
    "effort refusal keeps only its requested tier, effective model, fixed provider code, and accepted ladder",
    /requested tier "xhigh"/.test(refusedErr) &&
      /effective model "fake-model"/.test(refusedErr) &&
      /provider code invalid_request/.test(refusedErr) &&
      refusedErr.includes(`accepted tiers: ${acceptedLadder}`),
    refusedErr,
  );
  check(
    "downstream effort-refusal text never reaches stderr",
    !refusedErr.toLowerCase().includes(effortCanary.toLowerCase()) &&
      !refusedErr.includes("provider rejected xhigh") &&
      !refusedErr.includes("invalid_request: provider rejected"),
    refusedErr,
  );
  check("a seat whose effort was refused never reaches the roster", !announced.has("refusedpeer"), [...announced]);
  const refusedEntries = readJsonLines<{ ev: string; frame?: { req?: string; no_reply?: boolean } }>(refusedLog);
  check(
    "a seat whose effort was refused never takes a turn",
    !refusedEntries.some((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply),
    refusedEntries.filter((entry) => entry.ev === "request").map((entry) => entry.frame?.req),
  );

  const modelCanary = "MODEL-REFUSAL-CANARY-985-DO-NOT-PRINT";
  const modelCases = [
    {
      name: "prefixmodel",
      model: "cliproxy/fake-model",
      code: "model_prefix_rejected",
      env: {},
      request: "create_session",
    },
    {
      name: "refusedmodel",
      model: "refused-model",
      code: "model_refused",
      env: { FAKE_JCODE_REFUSE_MODEL: "refused-model", FAKE_JCODE_MODEL_ERROR: `invalid_request: ${modelCanary}` },
      request: "set_model",
    },
    {
      name: "mismatchedmodel",
      model: "requested-model",
      code: "model_mismatch",
      env: { FAKE_JCODE_RUNTIME_MODEL: "different-model" },
      request: "get_runtime_info",
    },
  ] as const;
  for (const modelCase of modelCases) {
    const caseLog = join(root, `${modelCase.name}.jsonl`);
    const failed = spawnHost({
      cwd: root,
      env: {
        ...env,
        PATH: `${shimDir}:${env.PATH ?? ""}`,
        FAKE_JCODE_LOG: caseLog,
        ...modelCase.env,
        JCODE_HOME: inheritedJcodeHome,
        COTAL_SPACE: "jcodehost",
        COTAL_NAME: modelCase.name,
        COTAL_ID: modelCase.name,
        COTAL_SERVERS: servers,
        COTAL_SUBSCRIBE: "team",
        COTAL_ALLOW_SUBSCRIBE: "team",
        COTAL_ALLOW_PUBLISH: "team",
        COTAL_JCODE_HOME: root,
        COTAL_JCODE_TUI: "0",
        COTAL_MODEL: modelCase.model,
        COTAL_CONTROL_SOCKET: join(root, `${modelCase.name}-control.sock`),
        COTAL_CONTROL_TOKEN: `${modelCase.name}-control-token`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let failedErr = "";
    failed.stderr?.on("data", (chunk: Buffer) => (failedErr += chunk.toString()));
    await Promise.race([once(failed, "exit"), sleep(20_000)]);
    const failedCode = failed.exitCode;
    await stopHostTree(failed, "SIGKILL");
    const expected = `Jcode host startup failed (${modelCase.code})`;
    const persisted = connectorLog(managedHome("jcodehost", modelCase.name));
    check(`${modelCase.code} names the connector-owned refusal`, failedCode === 1 && failedErr.includes(expected), { failedCode, failedErr });
    check(`${modelCase.code} fatal is persisted in the seat connector log`, persisted.includes(expected), persisted);
    check(`${modelCase.code} keeps downstream model text scrubbed`, !failedErr.includes(modelCanary) && !persisted.includes(modelCanary), { failedErr, persisted });
    const caseEntries = readFileSync(caseLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) as Array<{ ev?: string; frame?: { req?: string } }>;
    check(`${modelCase.code} reaches its real startup boundary`, caseEntries.some((entry) => entry.ev === "request" && entry.frame?.req === modelCase.request), caseEntries);
  }

  // #845 reproduction: `MeshAgent.start()` retries in the background. A post-join notice sent
  // immediately after it is not evidence of a completed join: the broker below is deliberately
  // unbound, so neither presence nor a roster can exist.
  const outagePort = await freePort();
  const outageServers = `nats://127.0.0.1:${outagePort}`;
  const outageLog = join(root, "join-outage.jsonl");
  outage = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: outageLog,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodeoutage",
      COTAL_NAME: "outagepeer",
      COTAL_ID: "outagepeer",
      COTAL_SERVERS: outageServers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "outage-control.sock"),
      COTAL_CONTROL_TOKEN: "outage-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let outageErr = "";
  outage.stderr?.on("data", (chunk: Buffer) => (outageErr += chunk.toString()));
  const outageEntries = (): Array<{ ev: string; frame?: { req?: string; content?: string; no_reply?: boolean } }> =>
    readJsonLines(outageLog);
  await waitFor("outage readiness proof", () => outageEntries().find((entry) => entry.ev === "orientation_done") ? true : undefined);
  await waitFor("outage broker refusal", () => /mesh unreachable/.test(outageErr) ? true : undefined);
  const findOutageNotice = () =>
    outageEntries().find(
      (entry) =>
        entry.ev === "request" &&
        entry.frame?.req === "send_message" &&
        entry.frame?.no_reply &&
        String(entry.frame.content).includes("earlier cotal_orientation result was captured before this join"),
    );
  check("post-join notice stays absent while the mesh is unreachable", !findOutageNotice(), { outageNotice: findOutageNotice(), outageErr });
  outageNats = spawn("nats-server", ["-js", "-p", String(outagePort), "-sd", join(root, "outage-js")], { stdio: "ignore" });
  for (let i = 0; i < 100 && !(await isReachable(outageServers)); i++) await sleep(50);
  await seedChannelRegistry({ servers: outageServers, space: "jcodeoutage", file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  outageOperator = new CotalEndpoint({ space: "jcodeoutage", servers: outageServers, card: { name: "outageoperator", kind: "agent", id: "outageoperator" }, channels: ["team"] });
  outageOperator.on("error", () => {});
  let outagePeerId: string | undefined;
  outageOperator.on("presence", (event: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (event.type !== "offline" && event.presence.card.name === "outagepeer") outagePeerId = event.presence.card.id;
  });
  await outageOperator.start();
  const joinedNotice = await waitFor("post-join notice after the recovered mesh join", () => findOutageNotice());
  await waitFor("recovered mesh presence", () => outagePeerId);
  check("post-join notice fires only after the later real mesh join", Boolean(joinedNotice) && Boolean(outagePeerId), { joinedNotice, outagePeerId });
  await stopHostTree(outage, "SIGTERM");
  check("the outage launch exits cleanly", outage.exitCode === 0, { code: outage.exitCode, stderr: outageErr });

  // #779 reproduction: the foreground observer belongs beside the session, before the slow
  // readiness request. The old host only spawns it after that request has completed.
  const tuiLog = join(root, "tui-order.jsonl");
  const foreground = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: tuiLog,
      FAKE_JCODE_TURN_DELAY_MS: "1000",
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "tuipeer",
      COTAL_ID: "tuipeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "1",
      COTAL_CONTROL_SOCKET: join(root, "tui-control.sock"),
      COTAL_CONTROL_TOKEN: "tui-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let foregroundErr = "";
  foreground.stderr?.on("data", (chunk: Buffer) => (foregroundErr += chunk.toString()));
  await waitFor("foreground readiness proof", () => existsSync(tuiLog) && readFileSync(tuiLog, "utf8").includes('"ev":"orientation_done"') ? true : undefined);
  const tuiEntries = readJsonLines<{ ev: string; frame?: { req?: string; content?: string; no_reply?: boolean } }>(tuiLog);
  const tuiAt = tuiEntries.findIndex((entry) => entry.ev === "tui");
  const readinessDoneAt = tuiEntries.findIndex((entry) => entry.ev === "orientation_done");
  check("foreground TUI starts before its readiness turn finishes", tuiAt >= 0 && tuiAt < readinessDoneAt, { tuiAt, readinessDoneAt, entries: tuiEntries });
  await stopHostTree(foreground, "SIGTERM");
  check("the early foreground TUI launch exits cleanly", foreground.exitCode === 0, { code: foreground.exitCode, stderr: foregroundErr });

  // Deliberate failing case: project MCP files would override Jcode's private cotal config, so the
  // host must refuse before it starts an API bridge rather than silently loading another server.
  writeFileSync(join(root, ".mcp.json"), '{"mcpServers":{}}');
  const blocked = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: join(root, "should-not-exist.jsonl"),
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "blocked",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "blocked-control.sock"),
      COTAL_CONTROL_TOKEN: "blocked-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let blockedErr = "";
  blocked.stderr?.on("data", (chunk: Buffer) => (blockedErr += chunk.toString()));
  await Promise.race([once(blocked, "exit"), sleep(10_000)]);
  check("project MCP config is refused rather than overlaid", blocked.exitCode !== 0 && /Jcode host startup failed \(project_mcp_config\)/.test(blockedErr), blockedErr);

  // The readiness turn is a provider call. A refusal there used to be collapsed to `(unknown)`,
  // forcing an external observer/UI to inspect private Jcode logs for the connector-originated
  // provider code and rejected model parameter (#828). Drive the exact event the SDK's `run()`
  // turns into HarnessError and assert the bounded public diagnostic, not private child text.
  rmSync(join(root, ".mcp.json"), { force: true });
  const refusalLog = join(root, "readiness-refusal.jsonl");
  const refusal = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: refusalLog,
      FAKE_JCODE_READINESS_REFUSAL: "1",
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "readinessrefusal",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "refused-control.sock"),
      COTAL_CONTROL_TOKEN: "refused-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let refusalErr = "";
  refusal.stderr?.on("data", (chunk: Buffer) => (refusalErr += chunk.toString()));
  await waitFor("provider refusal readiness request", () => {
    if (!existsSync(refusalLog)) return undefined;
    return readJsonLines<{ ev?: string; frame?: { req?: string; content?: string } }>(refusalLog).find(
      (entry: { ev?: string; frame?: { req?: string; content?: string } }) =>
        entry.ev === "request" && entry.frame?.req === "send_message" && entry.frame.content?.includes("cotal_orientation"),
    );
  });
  await waitFor("provider refusal host exit", () => refusal.exitCode === null ? undefined : refusal.exitCode, 20_000);
  check(
    "provider readiness refusal names its code and rejected model parameter",
    refusal.exitCode === 1 && /model_not_found/.test(refusalErr) && /rejected-model-id/.test(refusalErr),
    {
      exitCode: refusal.exitCode,
      signalCode: refusal.signalCode,
      stderr: refusalErr,
      fakeEvents: readJsonLines(refusalLog),
    },
  );
  check(
    "provider readiness refusal stays scrubbed beyond the classified fields",
    !refusalErr.includes("was refused by provider"),
    refusalErr,
  );
} finally {
  for (const proc of hosts) await stopHostTree(proc, "SIGKILL");
  check("teardown: every Jcode host process group is gone", hosts.every((proc) => !groupAlive(proc)), {
    started: hosts.length,
    alive: hosts.filter(groupAlive).map((proc) => proc.pid),
  });
  await operator?.stop().catch(() => {});
  await outageOperator?.stop().catch(() => {});
  nats.kill("SIGKILL");
  outageNats?.kill("SIGKILL");
  for (let i = 0; i < 100; i++) {
    if ((nats.exitCode !== null || nats.signalCode !== null) &&
        (outageNats === undefined || outageNats.exitCode !== null || outageNats.signalCode !== null)) break;
    await sleep(50);
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nJCODE HOST SMOKE PASSED (${pass} checks)`);
