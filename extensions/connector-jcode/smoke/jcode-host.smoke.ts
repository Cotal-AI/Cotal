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
import { CotalEndpoint, isReachable, resolvePeer, seedChannelRegistry } from "@cotal-ai/core";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor<T>(name: string, read: () => T | undefined | Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
    await sleep(100);
  }
}

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-host-"));
// Control sockets are AF_UNIX. os.tmpdir() on macOS and a long TMPDIR on Linux
// put `mismatchedmodel-control.sock` over sun_path (104/107) while the shorter
// prefix/refuse sockets still bind — the cell then exits 1 with a connector
// control-listen error instead of the model_mismatch diagnostic.
const sockRoot = mkdtempSync(join("/tmp", "cjh-"));
const controlSock = (name: string): string => join(sockRoot, name);
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
  name = "cotal_inbox",
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
    const result = await client.callTool({ name, arguments: arguments_ });
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
  let busyPeerId: string | undefined;
  let busyActivity = "";
  const announced = new Set<string>();
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string }; activity?: string } }) => {
    if (event.type === "offline") return;
    announced.add(event.presence.card.name);
    if (event.presence.card.name === "jcodepeer") peerId = event.presence.card.id;
    if (event.presence.card.name === "busypeer") {
      busyPeerId = event.presence.card.id;
      busyActivity = event.presence.activity ?? "";
    }
  });
  await operator.start();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  const inheritedJcodeHome = join(root, "source-jcode");
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "host-smoke-token", { mode: 0o600 });
  const journal = join(root, "session.journal.jsonl");
  child = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_JOURNAL: journal,
      FAKE_JCODE_RUNTIME_PROVIDER: "selected-provider",
      FAKE_JCODE_RUNTIME_ROUTES: JSON.stringify([
        { model: "fake-model", provider: "default-provider", api_method: "chat_completions", available: true, detail: "wrong route" },
        { model: "fake-model", provider: "selected-provider", api_method: "responses", available: true, detail: "active route" },
      ]),
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
      COTAL_CONTROL_SOCKET: controlSock("control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-host-smoke-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  await waitFor("fake bridge", () => entries().find((entry) => entry.ev === "listening"));
  await waitFor("mesh presence", () => peerId);
  check("Jcode host joins the mesh", Boolean(peerId));
  const journalModel = existsSync(journal)
    ? (JSON.parse(readFileSync(journal, "utf8").split("\n").filter(Boolean).at(-1) ?? "{}") as { meta?: { model?: string } }).meta?.model
    : undefined;
  check(
    "session journal records the requested model pin, not the harness default",
    journalModel === "fake-model",
    journalModel,
  );
  check(
    "session journal does not keep the harness default after setModel",
    journalModel !== "deepseek-v4-pro",
    journalModel,
  );
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
  const peerLog = connectorLog(peerHome);
  check(
    "a successful join with no spawn --prompt names that outcome",
    /pre-join readiness outcome: orientation proved; joining with no spawn --prompt/.test(peerLog) &&
      !/pre-join readiness outcome: timeout/.test(peerLog) &&
      !/pre-join readiness outcome: provider refusal/.test(peerLog),
    peerLog,
  );
  check("host copies auth mirror rather than linking it", lstatSync(join(peerHome, "auth.json")).isFile() && !lstatSync(join(peerHome, "auth.json")).isSymbolicLink());
  check("host copied auth mirror is owner-only", (statSync(join(peerHome, "auth.json")).mode & 0o777) === 0o600);

  // Jcode invokes this actual stdio MCP bridge, which relays across the live per-seat Unix socket
  // into the host's MeshAgent. A schema-valid explicit `peek:false` must not be rejected by either
  // hop: the bug was an adapter-only no-argument branch that advertised this input then refused it.
  const privateMcp = JSON.parse(readFileSync(join(peerHome, "mcp.json"), "utf8")) as {
    servers: { cotal: { env: Record<string, string>; shared?: boolean } };
  };
  // Jcode spawns a `shared: false` server once per session, so under a seat that runs subagents
  // every member session leaves its own bridge process alive until seat teardown. The bridge must
  // ride the daemon's pool; the daemon is seat-private, so pooling cannot cross seats.
  check("bridge entry rides the per-seat daemon pool instead of spawning per session", privateMcp.servers.cotal.shared === true, privateMcp.servers.cotal);
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
  const runtimeAt = requests.findIndex((entry) => (entry.frame as { req?: string }).req === "get_runtime_info");
  check("the selected model and provider route are verified before applying reasoning effort", runtimeAt >= 0 && effortAt > runtimeAt, { runtimeAt, effortAt });
  check(
    "accepted effort is attributed to the active provider route, not the first/default route",
    peerLog.includes("model fake-model is served by provider selected-provider via responses") &&
      !peerLog.includes("model fake-model is served by provider default-provider"),
    peerLog,
  );

  await stopHostTree(child, "SIGTERM");
  check("host exits cleanly on SIGTERM", child.exitCode === 0, { code: child.exitCode, stderr });

  // A variant does not require an explicit model pin. The connector must still fetch RuntimeInfo and
  // verify the provider route that will receive the effort instead of treating the provider default
  // as an unidentified fallback or applying the setting without route identity.
  const variantOnlyLog = join(root, "variant-only.jsonl");
  const variantOnly = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: variantOnlyLog,
      FAKE_JCODE_RUNTIME_MODEL: "runtime-default-model",
      FAKE_JCODE_RUNTIME_PROVIDER: "runtime-default-provider",
      FAKE_JCODE_RUNTIME_ROUTES: JSON.stringify([
        { model: "runtime-default-model", provider: "runtime-default-provider", api_method: "responses", available: true, detail: "active route" },
      ]),
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "variantonlypeer",
      COTAL_ID: "variantonlypeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_VARIANT: "high",
      COTAL_CONTROL_SOCKET: controlSock("variant-only-control.sock"),
      COTAL_CONTROL_TOKEN: "variant-only-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let variantOnlyErr = "";
  variantOnly.stderr?.on("data", (chunk: Buffer) => (variantOnlyErr += chunk.toString()));
  await waitFor("variant-only mesh presence", () => announced.has("variantonlypeer") ? true : undefined);
  const variantOnlyRequests = readJsonLines<{ ev: string; frame?: { req?: string; effort?: string; no_reply?: boolean } }>(variantOnlyLog)
    .filter((entry) => entry.ev === "request");
  const variantOnlyRuntimeAt = variantOnlyRequests.findIndex((entry) => entry.frame?.req === "get_runtime_info");
  const variantOnlyEffortAt = variantOnlyRequests.findIndex((entry) => entry.frame?.req === "set_reasoning_effort");
  const variantOnlyTurnAt = variantOnlyRequests.findIndex((entry) => entry.frame?.req === "send_message" && !entry.frame?.no_reply);
  check(
    "variant without an explicit model verifies its runtime route before applying effort",
    variantOnlyRuntimeAt >= 0 && variantOnlyEffortAt > variantOnlyRuntimeAt &&
      variantOnlyRequests[variantOnlyEffortAt]?.frame?.effort === "high" && variantOnlyTurnAt > variantOnlyEffortAt,
    { variantOnlyRuntimeAt, variantOnlyEffortAt, variantOnlyTurnAt, variantOnlyErr },
  );
  await stopHostTree(variantOnly, "SIGTERM");
  check("the variant-only launch exits cleanly", variantOnly.exitCode === 0, { code: variantOnly.exitCode, stderr: variantOnlyErr });

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
      COTAL_CONTROL_SOCKET: controlSock("race-control.sock"),
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

  // A seat resumed from a transcript that ends mid-turn is legitimately busy the moment it joins,
  // and the server refuses the post-join notice's context_message while it is. That refusal used to
  // reach the startup catch and kill an already-joined seat, taking its accumulated session with
  // it. The notice is cosmetic; the seat is not.
  const idleLog = join(root, "kickoff-without-inbox.jsonl");
  const idleRelease = join(root, "release-kickoff-without-inbox");
  const idleOnly = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: idleLog,
      FAKE_JCODE_BUSY_MODEL: "1",
      FAKE_JCODE_BUSY_AFTER_READINESS: "1",
      FAKE_JCODE_BUSY_AFTER_READINESS_STATUS: "1",
      FAKE_JCODE_BUSY_RELEASE_FILE: idleRelease,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "idleonlypeer",
      COTAL_ID: "idleonlypeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_JCODE_PROMPT: "KICKOFF-WITHOUT-ANY-INBOX-WAKE",
      COTAL_CONTROL_SOCKET: controlSock("idle-only-control.sock"),
      COTAL_CONTROL_TOKEN: "idle-only-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const idleEntries = () => readJsonLines<{ ev: string; status?: string; content?: string; frame?: { req?: string; content?: string; no_reply?: boolean } }>(idleLog);
  await waitFor("the no-inbox startup observes native busy", () =>
    idleEntries().find((entry) => entry.ev === "busy_after_readiness_status" && entry.status === "working"));
  writeFileSync(idleRelease, "idle");
  const idleKickoff = await waitFor("startup kickoff after idle without inbox work", () =>
    idleEntries().find((entry) => entry.ev === "request" && entry.frame?.req === "send_message" &&
      !entry.frame.no_reply && String(entry.frame.content).includes("KICKOFF-WITHOUT-ANY-INBOX-WAKE"))).catch(() => undefined);
  check("idle completion delivers the startup kickoff without any inbox wake", Boolean(idleKickoff), idleEntries());
  await stopHostTree(idleOnly, "SIGTERM");

  const busyLog = join(root, "join-notice-busy.jsonl");
  const busyRelease = join(root, "release-startup-busy");
  const busy = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: busyLog,
      FAKE_JCODE_BUSY_MODEL: "1",
      FAKE_JCODE_BUSY_AFTER_READINESS: "1",
      FAKE_JCODE_BUSY_AFTER_READINESS_STATUS: "1",
      FAKE_JCODE_BUSY_RELEASE_FILE: busyRelease,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "busypeer",
      COTAL_ID: "busypeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_JCODE_PROMPT: "KICKOFF-MUST-SURVIVE-REFUSED-NOTICE",
      COTAL_CONTROL_SOCKET: controlSock("busy-control.sock"),
      COTAL_CONTROL_TOKEN: "busy-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let busyErr = "";
  busy.stderr?.on("data", (chunk: Buffer) => (busyErr += chunk.toString()));
  await Promise.race([once(busy, "exit"), sleep(20_000)]);
  const busyEntries = readJsonLines<{ ev: string; client_processing?: boolean; reason?: string; request_kind?: string; frame?: { req?: string; content?: string; no_reply?: boolean } }>(busyLog);
  // Without this the cell is vacuous: a fake that never refuses would pass every assertion below
  // while the real server still rejects.
  const busyRefusal = busyEntries.find((entry) => entry.ev === "busy_agent_rejected");
  check("the post-join notice is actually refused as agent_busy, so this cell is not vacuous", busyRefusal?.reason === "agent_busy" && busyRefusal.request_kind === "context_message" && busyRefusal.client_processing === false, busyRefusal);
  const busyNotice = busyEntries.find((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && entry.frame?.no_reply === true && String(entry.frame?.content).includes("earlier cotal_orientation result was captured before this join"));
  const busyRead = () => readJsonLines<{ ev: string; status?: string; session_id?: string; frame?: { req?: string; content?: string; no_reply?: boolean } }>(busyLog);
  const busyTurns = () => busyRead().filter((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply);
  const kickoff = "KICKOFF-MUST-SURVIVE-REFUSED-NOTICE";
  const markerCount = (text: string, marker: string): number => text.split(marker).length - 1;
  await waitFor("the post-readiness continuation to make the watched session busy", () =>
    busyRead().find((entry) => entry.ev === "busy_after_readiness_status" && entry.status === "working"));
  const busyHome = managedHome("jcodehost", "busypeer");
  const busyMcp = jcodeMcpEntry(busyHome);
  const busySocket = busyMcp.env.COTAL_JCODE_MCP_SOCKET!;
  const busyToken = busyMcp.env.COTAL_JCODE_MCP_TOKEN!;
  const dnd = await callJcodeMcp(busyHome, busySocket, busyToken, { attention: "dnd" }, "cotal_status");
  check("the busy startup peer enters dnd through its real MCP tool", !dnd.isError, dnd);
  const deferred = "DND-AMBIENT-BEFORE-KICKOFF";
  await operator.multicast(deferred, { channel: "team" });
  // Jcode's cotal_inbox exposes pull-only traffic. The host's health activity is the
  // observable receipt for an automatic item that must remain owned by the connector.
  await waitFor("ordinary dnd traffic buffered before kickoff", () =>
    busyActivity.includes("inbound: 1 automatic queued") ? busyActivity : undefined);
  check("ordinary dnd traffic does not start a turn while kickoff is held", !busyTurns().some((entry) => String(entry.frame?.content).includes(deferred)), busyTurns());
  writeFileSync(busyRelease, "release");
  await waitFor("the external busy turn to become idle", () =>
    busyRead().find((entry) => entry.ev === "busy_after_readiness_status" && entry.status === "idle"));
  const kickoffTurn = await waitFor("the deferred kickoff turn", () =>
    busyTurns().find((entry) => String(entry.frame?.content).includes(kickoff))).catch(() => undefined);
  if (kickoffTurn) {
    await waitFor("the deferred kickoff turn boundary", () =>
      busyRead().find((entry) => entry.ev === "turn_done_emitted" && String((entry as { content?: string }).content).includes(kickoff))).catch(() => undefined);
    await sleep(250);
  }
  const kickoffTurns = busyTurns().filter((entry) => String(entry.frame?.content).includes(kickoff));
  const kickoffOccurrences = kickoffTurns.reduce((count, entry) => count + markerCount(String(entry.frame?.content), kickoff), 0);
  check(
    "the spawn kickoff prompt survives a refused post-join notice while the model is visibly busy exactly once",
    kickoffTurns.length === 1 && kickoffOccurrences === 1,
    { kickoffTurn, kickoffTurns, kickoffOccurrences },
  );
  check("the startup kickoff does not contain the deferred automatic inbox", !String(kickoffTurn?.frame?.content).includes(deferred), kickoffTurn);
  const deferredTurn = await waitFor("ordinary dnd traffic after kickoff without another wake", () =>
    busyTurns().find((entry) => String(entry.frame?.content).includes(deferred))).catch(() => undefined);
  check("ordinary dnd traffic deferred by kickoff reaches the following turn without another wake", Boolean(deferredTurn), { deferredTurn, turns: busyTurns() });
  await waitFor("the deferred dnd turn boundary", () =>
    busyRead().find((entry) => entry.ev === "turn_done_emitted" && String((entry as { content?: string }).content).includes(deferred)));
  const quietMode = await callJcodeMcp(busyHome, busySocket, busyToken, { channel: "team", mode: "quiet" }, "cotal_channel_mode");
  check("the startup peer enables quiet through its real MCP tool", !quietMode.isError, quietMode);
  const quiet = "QUIET-AMBIENT-MUST-STAY-PULL-ONLY";
  await operator.multicast(quiet, { channel: "team" });
  await waitFor("quiet traffic retained for explicit pull", async () => {
    const peek = await callJcodeMcp(busyHome, busySocket, busyToken, { peek: true });
    return !peek.isError && peek.text.includes(quiet) ? peek : undefined;
  });
  check("a seat whose post-join notice is refused still joins the mesh", announced.has("busypeer"), { announced: [...announced], stderr: busyErr });
  check("the refused notice is still sent as a no-reply context message, not promoted to a turn", Boolean(busyNotice), busyNotice);
  const settledTurnCount = busyTurns().length;
  await sleep(500);
  check("the deferred kickoff leaves no idle drive loop", busyTurns().length === settledTurnCount, busyTurns());
  // Surviving the refusal is not the same as still working. A seat that stayed up but lost its
  // mesh or tool channel would pass every assertion above, so drive real work through it: the
  // refused notice must cost the notice and nothing else.
  // These waits report a failed cell rather than throwing. A seat killed by the refusal never
  // reaches this work at all, and an unhandled timeout would crash the suite as an unrelated early
  // failure instead of naming which guarantee broke.
  await waitFor("busypeer presence", () => busyPeerId).catch(() => undefined);
  if (busyPeerId) await operator.unicast(busyPeerId, "post-refusal-work cotal_orientation");
  const busyTurn = await waitFor("a Harness API turn after the refused notice", () =>
    busyRead().find((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply && String(entry.frame?.content).includes("post-refusal-work"))).catch(() => undefined);
  check("a seat whose notice was refused still receives later mesh work as a real turn", Boolean(busyTurn), busyTurn);
  // The fake records `orientation_done` only when a turn actually reaches the cotal_orientation
  // tool, so this is the tool path running end to end rather than a message merely being accepted.
  // The readiness turn logs one before the join; a second proves the post-refusal turn ran too.
  const busyToolRuns = await waitFor("the post-refusal turn reaches its tool", () => {
    const runs = busyRead().filter((entry) => entry.ev === "orientation_done");
    return runs.length >= 2 ? runs : undefined;
  }).catch(() => undefined);
  check("the post-refusal turn reaches the cotal tool, so the refusal cost the notice and not the session", (busyToolRuns?.length ?? 0) >= 2, busyToolRuns);
  check("quiet traffic never rides the kickoff or later directed turn", !busyTurns().some((entry) => String(entry.frame?.content).includes(quiet)), busyTurns());
  const quietPull = await callJcodeMcp(busyHome, busySocket, busyToken, { peek: false });
  check("quiet traffic remains available to explicit pull after later work", !quietPull.isError && quietPull.text.includes(quiet), quietPull);
  await stopHostTree(busy, "SIGTERM");
  check("the launch whose post-join notice was refused exits cleanly", busy.exitCode === 0, { code: busy.exitCode, stderr: busyErr });

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
      COTAL_CONTROL_SOCKET: controlSock("absent-control.sock"),
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
      FAKE_JCODE_RUNTIME_PROVIDER: "selected-refusal-provider",
      FAKE_JCODE_RUNTIME_ROUTES: JSON.stringify([
        { model: "fake-model", provider: "wrong-default-provider", api_method: "chat_completions", available: true, detail: "wrong route" },
        { model: "fake-model", provider: "selected-refusal-provider", api_method: "responses", available: true, detail: "active route" },
      ]),
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
      COTAL_CONTROL_SOCKET: controlSock("refused-control.sock"),
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
      /provider "selected-refusal-provider" via "responses"/.test(refusedErr) &&
      !refusedErr.includes("wrong-default-provider") &&
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

  // The Harness operation has two distinct invalid_request outcomes. A model/profile can reject the
  // reasoning-effort CAPABILITY itself, with no accepted-tier ladder. That is not a bad tier and must
  // not send the operator searching for a neighbouring value that the active route will also refuse.
  const unsupportedLog = join(root, "unsupported-effort.jsonl");
  const unsupported = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: unsupportedLog,
      FAKE_JCODE_REFUSE_EFFORT: "high",
      FAKE_JCODE_EFFORT_ERROR: "Reasoning effort is not supported by the current model/profile. It works for OpenRouter, DeepSeek-family and GPT-family reasoning models, and profiles with supports_reasoning_effort = true.",
      FAKE_JCODE_RUNTIME_MODEL: "capability-model",
      FAKE_JCODE_RUNTIME_PROVIDER: "profile-without-effort",
      FAKE_JCODE_RUNTIME_ROUTES: JSON.stringify([
        { model: "capability-model", provider: "wrong-default", api_method: "chat_completions", available: true, detail: "wrong route" },
        { model: "capability-model", provider: "profile-without-effort", api_method: "openai-compatible:plain", available: true, detail: "active route" },
      ]),
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "unsupportedpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_MODEL: "capability-model",
      COTAL_VARIANT: "high",
      COTAL_CONTROL_SOCKET: controlSock("unsupported-control.sock"),
      COTAL_CONTROL_TOKEN: "unsupported-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let unsupportedErr = "";
  unsupported.stderr?.on("data", (chunk: Buffer) => (unsupportedErr += chunk.toString()));
  await Promise.race([once(unsupported, "exit"), sleep(20_000)]);
  const unsupportedCode = unsupported.exitCode;
  await stopHostTree(unsupported, "SIGKILL");
  check("a verified route without reasoning-effort capability ends the launch", unsupportedCode === 1, { unsupportedCode, unsupportedErr });
  check(
    "capability refusal is not relabelled as a tier-ladder refusal",
    unsupportedErr.includes("does not support reasoning effort") &&
      unsupportedErr.includes('model "capability-model"') &&
      unsupportedErr.includes('provider "profile-without-effort"') &&
      unsupportedErr.includes('via "openai-compatible:plain"') &&
      !unsupportedErr.includes("accepted tiers:") &&
      !unsupportedErr.includes("Jcode reasoning effort refused"),
    unsupportedErr,
  );
  check("a route without effort capability never reaches the roster", !announced.has("unsupportedpeer"), [...announced]);
  const unsupportedEntries = readJsonLines<{ ev: string; frame?: { req?: string; no_reply?: boolean } }>(unsupportedLog);
  check(
    "a route without effort capability never takes a turn",
    !unsupportedEntries.some((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame?.no_reply),
    unsupportedEntries.filter((entry) => entry.ev === "request").map((entry) => entry.frame?.req),
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
        COTAL_CONTROL_SOCKET: controlSock(`${modelCase.name}-control.sock`),
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
      COTAL_CONTROL_SOCKET: controlSock("outage-control.sock"),
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
      COTAL_CONTROL_SOCKET: controlSock("tui-control.sock"),
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
      COTAL_CONTROL_SOCKET: controlSock("blocked-control.sock"),
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
      COTAL_CONTROL_SOCKET: controlSock("refused-control.sock"),
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
  // The Jcode child is spawned `stdio: "inherit"`, so its own provider text reaches this same
  // stderr pipe. Matching the codes there is therefore satisfied by the child and cannot witness
  // the host rendering them. The seat's connector log is written only by writeJcodeDiagnostic, so
  // assert the classified line there: that is the one place only the host can reach.
  const refusalLogText = connectorLog(managedHome("jcodehost", "readinessrefusal"));
  check(
    "provider readiness refusal names its code and rejected model parameter",
    refusal.exitCode === 1 &&
      /model_not_found/.test(refusalErr) &&
      /rejected-model-id/.test(refusalErr) &&
      /fatal: Jcode readiness turn refused model "rejected-model-id" \(model_not_found\)/.test(refusalLogText),
    {
      exitCode: refusal.exitCode,
      signalCode: refusal.signalCode,
      stderr: refusalErr,
      connectorLog: refusalLogText,
      fakeEvents: readJsonLines(refusalLog),
    },
  );
  check(
    "provider readiness refusal names that outcome, not a timeout or a missing prompt",
    /pre-join readiness outcome: provider refusal/.test(refusalErr) &&
      !/pre-join readiness outcome: timeout/.test(refusalErr) &&
      !/joining with no spawn --prompt/.test(refusalErr) &&
      !/submitting the spawn --prompt/.test(refusalErr),
    refusalErr,
  );
  check(
    "provider readiness refusal stays scrubbed beyond the classified fields",
    !refusalErr.includes("was refused by provider"),
    refusalErr,
  );

  // #1216: a long readiness turn used to keep the host alive with no mesh presence at all.
  // The persona is already in the transcript, the kickoff prompt is not, and cotal_dm fails
  // with `no peer`. Bound that turn, and name the pre-join state while it is still running.
  const gateLog = join(root, "readiness-gate.jsonl");
  const personaFile = join(root, "slowpeer.md");
  writeFileSync(
    personaFile,
    "---\nname: slowpeer\nrole: reviewer\n---\nHEAVY-PERSONA-1216-DO-WORK-NOW\n",
  );
  const gateTurnMs = 2_500;
  const gateDeadlineMs = 800;
  const slow = spawnHost({
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: gateLog,
      FAKE_JCODE_TURN_DELAY_MS: String(gateTurnMs),
      COTAL_JCODE_READINESS_TIMEOUT_MS: String(gateDeadlineMs),
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodehost",
      COTAL_NAME: "slowpeer",
      COTAL_ID: "slowpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_AGENT_FILE: personaFile,
      COTAL_JCODE_PROMPT: "KICKOFF-1216-DO-THE-REVIEW",
      COTAL_CONTROL_SOCKET: controlSock("slow-control.sock"),
      COTAL_CONTROL_TOKEN: "slow-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let slowErr = "";
  slow.stderr?.on("data", (chunk: Buffer) => (slowErr += chunk.toString()));
  const gateEntries = (): Array<{ ev: string; frame?: { req?: string; content?: string; no_reply?: boolean } }> =>
    readJsonLines(gateLog);
  await waitFor("slowpeer readiness turn in flight", () => {
    const orientation = gateEntries().find(
      (entry) =>
        entry.ev === "request" &&
        entry.frame?.req === "send_message" &&
        !entry.frame?.no_reply &&
        String(entry.frame?.content).includes("cotal_orientation"),
    );
    return orientation ? true : undefined;
  });
  await sleep(200);
  const midAlive = slow.exitCode === null && slow.signalCode === null;
  const midRoster = operator.getRoster().filter((p) => p.card.name === "slowpeer" && p.status !== "offline");
  const midPeer = resolvePeer(operator.getRoster(), "slowpeer", { selfId: operator.id });
  const midDmError = midPeer ? undefined : `no peer "slowpeer" in space "jcodehost"`;
  const midPersona = gateEntries().find(
    (entry) =>
      entry.ev === "request" &&
      entry.frame?.req === "send_message" &&
      entry.frame?.no_reply &&
      String(entry.frame?.content).includes("HEAVY-PERSONA-1216-DO-WORK-NOW"),
  );
  const midKickoff = gateEntries().find(
    (entry) =>
      entry.ev === "request" &&
      entry.frame?.req === "send_message" &&
      !entry.frame?.no_reply &&
      String(entry.frame?.content).includes("KICKOFF-1216-DO-THE-REVIEW"),
  );
  const midLog = connectorLog(managedHome("jcodehost", "slowpeer"));
  check("a long readiness turn keeps the host alive before join", midAlive, { exitCode: slow.exitCode, signalCode: slow.signalCode, stderr: slowErr });
  check("a long readiness turn has no mesh presence", midRoster.length === 0 && !announced.has("slowpeer"), { midRoster, announced: [...announced] });
  check(
    "cotal_dm to a seat still at the readiness gate fails with no peer",
    midDmError === `no peer "slowpeer" in space "jcodehost"`,
    { midPeer, midDmError },
  );
  check("the persona is already in the transcript before the gate returns", Boolean(midPersona), midPersona);
  check("the kickoff prompt is not submitted while the gate is still open", !midKickoff, midKickoff);
  check(
    "the connector log names the pre-join readiness gate while that turn is still running",
    /pre-join readiness/.test(midLog) && /cotal_orientation/.test(midLog),
    midLog,
  );
  // The wait lives inside this named check: a mutant that drops the bound must redden
  // this assertion, not a helper that times out before it.
  let timedOutExit: number | null | undefined;
  try {
    timedOutExit = await waitFor("slowpeer readiness timeout exit", () => (slow.exitCode === null ? undefined : slow.exitCode), 15_000);
  } catch {
    timedOutExit = slow.exitCode;
  }
  check(
    "a readiness turn that overruns its bound ends the launch",
    timedOutExit !== null && timedOutExit !== undefined && timedOutExit !== 0,
    { code: timedOutExit, stderr: slowErr },
  );
  const afterKickoff = gateEntries().find(
    (entry) =>
      entry.ev === "request" &&
      entry.frame?.req === "send_message" &&
      !entry.frame?.no_reply &&
      String(entry.frame?.content).includes("KICKOFF-1216-DO-THE-REVIEW"),
  );
  check("a timed-out readiness turn never reaches the roster", !announced.has("slowpeer"), [...announced]);
  check("a timed-out readiness turn never submits the kickoff prompt", !afterKickoff, afterKickoff);
  check(
    "a timed-out readiness turn is named as a readiness timeout, not unknown",
    /readiness_timeout/.test(slowErr) || /readiness turn exceeded/.test(slowErr),
    slowErr,
  );
  const afterLog = connectorLog(managedHome("jcodehost", "slowpeer"));
  check(
    "a timed-out readiness turn names its outcome as timeout, not a hang or a missing prompt",
    /pre-join readiness outcome: timeout/.test(afterLog) &&
      /discarding that in-flight turn/.test(afterLog) &&
      !/pre-join readiness outcome: provider refusal/.test(afterLog) &&
      !/joining with no spawn --prompt/.test(afterLog) &&
      !/submitting the spawn --prompt/.test(afterLog),
    afterLog,
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
