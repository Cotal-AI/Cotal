/** Shipped stdio MCP command on a private static-auth broker. Run after building cotal-ai. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { awaitBrokerReady, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const root = mkdtempSync(join(tmpdir(), "cotal-mcp-command-"));
const runtime = join(root, "runtime");
mkdirSync(runtime, { mode: 0o700 });
process.env.COTAL_HOME = join(root, "cotal");
const { createSpaceAuth, isReachable, mintCreds, newIdentity, seedChannelRegistry, setupSpaceStreams } = await import("@cotal-ai/core");
const { authDir, recordMesh, saveSpaceAuth } = await import("@cotal-ai/workspace");
const { bootBroker } = await import("../../implementations/manager/smoke/_boot-broker.js");
const space = `mcpsmoke${process.pid}`;
const project = join(root, "project");
mkdirSync(join(project, ".cotal", "agents"), { recursive: true });
writeFileSync(join(project, ".cotal", "agents", "default.md"), "---\nname: default\nrole: reviewer\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\n");
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
Object.assign(env, { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"), XDG_RUNTIME_DIR: runtime,
  COTAL_HOME: process.env.COTAL_HOME, TMPDIR: runtime, COTAL_NO_UPDATE_CHECK: "1", NO_COLOR: "1" });
for (const dir of [env.HOME!, env.XDG_CONFIG_HOME!, env.COTAL_HOME!]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const bin = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const children = new Set<ChildProcessWithoutNullStreams>();
let count = 0;
function check(name: string, value: unknown): asserts value { assert.ok(value, name); console.log(`ok ${++count}: ${name}`); }
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function child(args: string[]): ChildProcessWithoutNullStreams {
  const p = spawn(process.execPath, [bin, ...args], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
  children.add(p);
  p.on("close", () => children.delete(p));
  return p;
}
function server(args: string[] = [], selected = space) {
  const p = child(["mcp", "--space", selected, ...args]);
  const output: string[] = [];
  const errors: string[] = [];
  p.stderr.on("data", (chunk) => errors.push(String(chunk)));
  let next = 0;
  const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const lines = createInterface({ input: p.stdout });
  lines.on("line", (line) => {
    output.push(line);
    let r: any;
    try { r = JSON.parse(line); } catch { assert.fail(`non-MCP stdout: ${line}`); }
    assert.equal(r.jsonrpc, "2.0");
    const held = pending.get(r.id);
    if (held) { clearTimeout(held.timer); pending.delete(r.id); held.resolve(r); }
  });
  p.on("close", () => {
    for (const held of pending.values()) { clearTimeout(held.timer); held.reject(new Error(`server exited: ${errors.join("")}`)); }
    pending.clear();
    writeFileSync(join(root, `mcp-${p.pid}.stdout`), output.join("\n"));
    writeFileSync(join(root, `mcp-${p.pid}.stderr`), errors.join(""));
  });
  const request = (method: string, params: object = {}) => {
    const id = ++next;
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${errors.join("")}`)); }, 35_000);
      pending.set(id, { resolve, reject, timer });
    });
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return { id, result };
  };
  return {
    p, request,
    cancel(id: number) {
      p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "test cancellation" } })}\n`);
      const held = pending.get(id);
      if (held) { clearTimeout(held.timer); pending.delete(id); held.resolve(undefined); }
    },
    async start() {
      const r = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } }).result;
      check("MCP initialize succeeds", r.result?.serverInfo.name === "cotal");
      p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    },
    async tool(name: string, args: object = {}) { return (await request("tools/call", { name, arguments: args }).result).result; },
  };
}
const text = (r: any): string => r?.content?.map((c: any) => c.text ?? "").join("\n") ?? "";
function connection(r: any): string {
  check("connection opens through shared gateway", !r.isError && /connection_id: ([a-f0-9-]+)/.test(text(r)));
  return /connection_id: ([a-f0-9-]+)/.exec(text(r))![1]!;
}
const identities = () => readdirSync(runtime).filter((n) => n.startsWith("cotal-app-identity-"));
const auth = await createSpaceAuth(space);
const open = process.argv.includes("--open");
const broker = open ? await (async () => {
  const port = await freePort();
  const store = mkdtempSync(join(root, SMOKE_BROKER_TOKEN));
  const p = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", store], { stdio: "ignore" });
  const release = teardownOnSignal(p, store);
  const servers = `nats://127.0.0.1:${port}`;
  try { await awaitBrokerReady(async () => p.exitCode === null && await isReachable(servers), { servers, attempts: 25, delayMs: 200 }); }
  catch (error) { await killAndAwaitExit(p); release(); throw error; }
  return { servers, async stop() { await killAndAwaitExit(p); release(); } };
})() : await bootBroker(auth);
try {
  saveSpaceAuth(authDir(project), auth);
  const creds = open ? undefined : await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space, creds });
  await seedChannelRegistry({ servers: broker.servers, space, creds, file: { channels: { general: {} } } });
  recordMesh({ space, server: broker.servers, root: project, mode: open ? "open" : "auth", origin: "manual", ts: new Date().toISOString() });
  if (open) {
    const s = server();
    await s.start();
    const id = connection(await s.tool("cotal_connect", { name: "open.reader" }));
    check("open mesh uses a stable identity without static credential authority", identities().length === 1 && text(await s.tool("cotal_orientation", { connection_id: id })).includes("open.reader"));
    check("open connection can send on its persona's channel", !(await s.tool("cotal_send", { connection_id: id, channel: "general", text: "open control" })).isError);
    const exited = once(s.p, "close");
    s.p.stdin.end();
    check("open server EOF retires local records", (await exited)[0] === 0 && identities().length === 0);
  } else if (process.argv.includes("--name-race")) {
    const a = server(), b = server();
    await Promise.all([a.start(), b.start()]);
    const results = await Promise.all([a.tool("cotal_connect", { name: "racing" }), b.tool("cotal_connect", { name: "racing" })]);
    const successes = results.filter((r) => !r.isError);
    const names = successes.map((r) => /^Connected as ([^.]+)\./.exec(text(r))?.[1]);
    check("two servers cannot share one alias", successes.length >= 1 && new Set(names).size === successes.length);
    for (const s of [a, b]) { const exit = once(s.p, "close"); s.p.stdin.end(); await exit; }
    check("cross-process admission leaves no identities after EOF", identities().length === 0);
  } else if (process.argv.includes("--wake-edges")) {
    const socket = join(runtime, "wake.sock");
    const s = server(["--wake-socket", socket]);
    await s.start();
    const id = connection(await s.tool("cotal_connect", { name: "wake_owner" }));
    const listener = child(["mcp", "wait", "--wake-socket", socket, "--connection", id]);
    let errors = "";
    listener.stderr.on("data", (chunk) => { errors += String(chunk); });
    const listenerExit = once(listener, "close");
    await wait(750);
    await s.tool("cotal_disconnect", { connection_id: id });
    check("background listener fails on exact disconnect", (await listenerExit)[0] !== 0 && /disconnected|not active/.test(errors));
    const unknown = child(["mcp", "wait", "--wake-socket", socket, "--connection", "00000000-0000-0000-0000-000000000000"]);
    const unknownExit = once(unknown, "close");
    unknown.stderr.resume();
    check("unknown wake handle refuses", (await unknownExit)[0] !== 0);
    const current = connection(await s.tool("cotal_connect", { name: "wake_shutdown" }));
    const reader = child(["mcp", "wait", "--wake-socket", socket, "--connection", current]);
    reader.stderr.resume();
    const readerExit = once(reader, "close");
    await wait(750);
    const serverExit = once(s.p, "close");
    s.p.stdin.end();
    check("server EOF releases its background listener", (await readerExit)[0] !== 0);
    check("server EOF with a listener retires identities", (await serverExit)[0] === 0 && identities().length === 0 && !existsSync(socket));
    const broken = server();
    await broken.start();
    connection(await broken.tool("cotal_connect", { name: "broken_output" }));
    const brokenExit = once(broken.p, "close");
    broken.p.stdout.destroy();
    const dropped = broken.tool("cotal_roster", { connection_id: "unknown" }).catch(() => undefined);
    await brokenExit;
    await dropped;
    check("broken MCP output stops and retires its identities", identities().length === 0);
  } else if (!process.argv.includes("--edges")) {
  for (const args of [["help"], ["help", "mcp"], ["chat", "--help"]]) {
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: project, env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "1" }, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    check(`${args.join(" ")} documents the shipped entrypoint`, args[0] === "chat" ? r.stdout.includes("--stdio") : r.stdout.includes("mcp"));
  }
  const socket = join(runtime, "wake.sock");
  const s = server(["--wake-socket", socket]);
  await s.start();
  const tools = (await s.request("tools/list").result).result.tools.map((t: any) => t.name);
  check("gateway tools include connect, wait and disconnect without managed spawn", ["cotal_connect", "cotal_wait", "cotal_disconnect"].every((t) => tools.includes(t)) && !tools.includes("cotal_spawn"));
  const invalid = await s.tool("cotal_connect", { name: "bad/name" });
  check("invalid names issue no identity", invalid.isError && identities().length === 0);
  const excessive = await s.tool("cotal_connect", { name: "too_wide", channels: [{ channel: "secret", access: "read-post" }] });
  check("permissions outside the default persona refuse", excessive.isError && identities().length === 0);
  const [a, b] = await Promise.all([s.tool("cotal_connect", { name: "reader" }), s.tool("cotal_connect", { name: "reader" })]);
  const first = connection(a), second = connection(b);
  check("concurrent name requests get different identities and names", first !== second && text(b).includes("reader_2"));
  check("static terminal records remain live after connect", identities().length === 2);
  check("wake socket is owner-only", (statSync(socket).mode & 0o777) === 0o600);
  check("missing connection never defaults", (await s.tool("cotal_roster", {})).isError);
  check("unknown connection never defaults", (await s.tool("cotal_roster", { connection_id: "unknown" })).isError);
  await s.tool("cotal_status", { connection_id: first, attention: "dnd" });
  const waiting = s.request("tools/call", { name: "cotal_wait", arguments: { connection_id: first } });
  await wait(100);
  await s.tool("cotal_dm", { connection_id: second, to: "reader", text: "live wait delivery" });
  check("cotal_wait receives a live DM", text((await waiting.result).result).includes("live wait delivery"));
  const cancelled = s.request("tools/call", { name: "cotal_wait", arguments: { connection_id: first } });
  await wait(100);
  s.cancel(cancelled.id);
  await cancelled.result;
  const wake = child(["mcp", "wait", "--wake-socket", socket, "--connection", first]);
  let wakeText = "";
  let wakeError = "";
  wake.stdout.on("data", (chunk) => { wakeText += String(chunk); });
  wake.stderr.on("data", (chunk) => { wakeError += String(chunk); });
  const woke = once(wake, "close");
  await s.tool("cotal_dm", { connection_id: second, to: "reader", text: "background wake delivery" });
  assert.equal((await woke)[0], 0, wakeError);
  check("background command wakes for unread DM", JSON.parse(wakeText).connection_id === first);
  check("notification did not consume content", text(await s.tool("cotal_inbox", { connection_id: first })).includes("background wake delivery"));
  check("orientation retains the same connected identity", text(await s.tool("cotal_orientation", { connection_id: first })).includes("reader"));
  check("disconnect retires its exact identity", !(await s.tool("cotal_disconnect", { connection_id: first })).isError && identities().length === 1);
  check("retired handle cannot read another inbox", (await s.tool("cotal_inbox", { connection_id: first })).isError);
  const eof = once(s.p, "close");
  s.p.stdin.end();
  check("EOF closes the server cleanly", (await eof)[0] === 0);
  check("EOF retires remaining identities and removes owned socket", identities().length === 0 && !existsSync(socket));
  const t = server();
  await t.start();
  connection(await t.tool("cotal_connect", { name: "signal_reader" }));
  const terminated = once(t.p, "close");
  t.p.kill("SIGTERM");
  check("SIGTERM finishes owned identity retirement", (await terminated)[0] === 143 && identities().length === 0);
  } else {
    const refusal = async (args: string[], pattern: RegExp): Promise<void> => {
      const p = child(["mcp", ...args]);
      let error = "";
      p.stderr.on("data", (chunk) => { error += String(chunk); });
      p.stdin.end();
      const [code] = await once(p, "close");
      check(`refuses ${args.join(" ")}`, code !== 0 && pattern.test(error));
    };
    await refusal(["wait"], /needs --wake-socket/);
    await refusal(["--space", " "], /space.*empty|space.*name/i);
    await refusal(["--wake-socket", "relative.sock"], /absolute path/);
    const publicDir = join(root, "public");
    mkdirSync(publicDir, { mode: 0o755 });
    chmodSync(publicDir, 0o755);
    await refusal(["--wake-socket", join(publicDir, "wake.sock")], /owner-private parent/);
    const existing = join(runtime, "existing.sock");
    writeFileSync(existing, "held");
    await refusal(["--wake-socket", existing], /already exists/);
    check("refused socket leaves the existing entry intact", statSync(existing).isFile() && statSync(existing).size === 4);
    const s = server();
    await s.start();
    const dotted = await s.tool("cotal_connect", { name: "bad.name" });
    check("static alias refusal leaves no partial identity", dotted.isError && /KV-safe/.test(text(dotted)) && identities().length === 0);
    const missing = server([], "missing");
    await missing.start();
    check("unknown selected space never falls back", (await missing.tool("cotal_connect", { name: "missing" })).isError && identities().length === 0);
    const missingExit = once(missing.p, "close");
    missing.p.stdin.end();
    await missingExit;
    recordMesh({ space, server: broker.servers, root: project, mode: "auth", origin: "manual", policy: { events: "required" }, ts: new Date().toISOString() });
    const strictServer = server();
    await strictServer.start();
    const strictResult = await strictServer.tool("cotal_connect", { name: "events" });
    check("native-event-required space issues nothing", strictResult.isError && /native conversation event source/.test(text(strictResult)) && identities().length === 0);
    const strictExit = once(strictServer.p, "close");
    strictServer.p.stdin.end();
    await strictExit;
    recordMesh({ space, server: broker.servers, root: project, mode: "auth", origin: "manual", ts: new Date().toISOString() });
    const signed = `${space}user`;
    const signedRoot = join(root, "signed");
    mkdirSync(signedRoot);
    recordMesh({ space: signed, server: broker.servers, root: signedRoot, mode: "user", origin: "manual",
      userAuth: { provider: "cotal", idp: { url: "https://example.invalid", issuer: "https://example.invalid", audience: "cotal" } }, ts: new Date().toISOString() });
    const user = server([], signed);
    await user.start();
    const denied = await user.tool("cotal_connect", { name: "signed" });
    check("signed-in host refuses without inventing native session metadata", denied.isError && /native session identity/.test(text(denied)) && identities().length === 0);
    const userExit = once(user.p, "close");
    user.p.stdin.end();
    await userExit;
    const first = connection(await s.tool("cotal_connect", { name: "orphan" }));
    check("orphan has a live handle before crash", first.length === 36 && identities().length === 1);
    const crashed = once(s.p, "close");
    s.p.kill("SIGKILL");
    await crashed;
    check("crash retains exact lifecycle recovery record", identities().length === 1);
    const recovered = server();
    await recovered.start();
    connection(await recovered.tool("cotal_connect", { name: "orphan" }));
    check("next connect retires orphan before replacing it", identities().length === 1);
    const interrupted = once(recovered.p, "close");
    recovered.p.kill("SIGINT");
    check("SIGINT retires recovered connection", (await interrupted)[0] === 130 && identities().length === 0);
    const early = server();
    await early.start();
    const inFlight = early.tool("cotal_connect", { name: "early_eof" }).catch(() => undefined);
    const earlyExit = once(early.p, "close");
    early.p.stdin.end();
    await earlyExit;
    await inFlight;
    check("EOF during issuance leaves no live or unretired identity", identities().length === 0);
  }
  console.log(`${count} checks passed; retained evidence ${root}`);
} finally {
  for (const p of children) await killAndAwaitExit(p);
  await broker.stop();
}
