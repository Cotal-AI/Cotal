/** Drive the shipped stdio MCP command against private static and open brokers. No native host needed. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal, createSuite } from "@cotal-ai/smoke-kit";
import type { IssuedAuthorityRef } from "@cotal-ai/core";

const { check, finish } = createSuite();
const scratch = mkdtempSync(join(tmpdir(), "cotal-mcp-live-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
for (const [key, folder] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_RUNTIME_DIR: "run", COTAL_HOME: "cotal", TMPDIR: "tmp" })) {
  env[key] = join(scratch, folder);
  mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
}
Object.assign(env, { COTAL_TELEMETRY: "off", NO_COLOR: "1" });
process.env.COTAL_HOME = env.COTAL_HOME;
process.env.TMPDIR = env.TMPDIR;
const bin = resolve(import.meta.dirname, "../dist/cotal.js");
const {
  CotalEndpoint, createSpaceAuth, mintCreds, newIdentity, setupSpaceStreams, seedChannelRegistry,
  isReachable, withIssuerSession, issuedAttemptKey, issuedBucket,
} = await import("@cotal-ai/core");
const { authDir, saveSpaceAuth, recordMesh, TERMINAL_SEAT_HORIZON_SEC } = await import("@cotal-ai/workspace");
const { bootBroker } = await import("../../implementations/manager/smoke/_boot-broker.js");

async function until(test: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (const end = Date.now() + 15_000; Date.now() < end; await sleep(50)) if (await test()) return;
  throw new Error(message);
}

interface Reply {
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string }>; tools?: Array<{ name: string }> };
  error?: unknown;
}
const text = (reply: Reply): string => reply.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
const children: Rpc[] = [];
class Rpc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  readonly pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  seq = 0;
  badOutput = "";
  constructor(readonly space: string, tag: string) {
    this.child = spawn(process.execPath, [bin, "mcp", "--space", space], { cwd: scratch, env, stdio: "pipe" });
    children.push(this);
    let output = "", errors = "";
    this.child.stdout.on("data", (chunk) => { output += String(chunk); });
    this.child.stderr.on("data", (chunk) => { errors += String(chunk); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const reply = JSON.parse(line) as Reply & { id?: number };
        assert.equal((reply as { jsonrpc?: string }).jsonrpc, "2.0");
        if (reply.id === undefined) return;
        const p = this.pending.get(reply.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(reply.id); p.resolve(reply); }
      } catch { this.badOutput += line; }
    });
    this.exited = new Promise((resolveExit, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code) => {
        writeFileSync(join(scratch, `${tag}.stdout`), output);
        writeFileSync(join(scratch, `${tag}.stderr`), errors);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exited ${code}`)); }
        this.pending.clear();
        resolveExit(code);
      });
    });
  }
  request(method: string, params: object): Promise<Reply> {
    const id = ++this.seq;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP request ${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve: resolveReply, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    return this.request("tools/call", { name, arguments: args });
  }
  async initialize(): Promise<void> {
    const reply = await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-smoke", version: "1" } });
    assert.ok(reply.result);
    assert.equal(reply.error, undefined);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }
  async end(signal?: "SIGINT" | "SIGTERM"): Promise<void> {
    if (signal) this.child.kill(signal);
    else this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([this.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP shutdown timed out")), 15_000); })]);
      assert.equal(code, 0);
      assert.equal(this.badOutput, "", "stdout is exclusively MCP");
    } finally { clearTimeout(timer); }
  }
}
function run(args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: scratch, env, encoding: "utf8", timeout: 30_000 });
}
const identities = () => readdirSync(env.TMPDIR!).filter((name) => name.startsWith("cotal-app-identity-"));

async function competingNames(space: string, tag: string): Promise<void> {
  const peers = [new Rpc(space, `${tag}-one`), new Rpc(space, `${tag}-two`), new Rpc(space, `${tag}-observer`)];
  const handle = (reply: Reply): string => {
    assert.ok(!reply.result?.isError, text(reply));
    const id = /connection_id: ([^\s]+)/.exec(text(reply))?.[1];
    assert.ok(id, text(reply));
    return id;
  };
  try {
    await Promise.all(peers.map((peer) => peer.initialize()));
    const sequential = `${tag}_seq`;
    const first = await peers[0]!.call("cotal_connect", { name: sequential });
    const second = await peers[1]!.call("cotal_connect", { name: sequential });
    check(`${tag}: sequential positive control keeps the name and reports the suffix`,
      text(first).startsWith(`Connected as ${sequential}.\n`) && text(second).startsWith(`Connected as ${sequential}_2 (`));
    await peers[0]!.call("cotal_disconnect", { connection_id: handle(first) });
    await peers[1]!.call("cotal_disconnect", { connection_id: handle(second) });

    const name = `${tag}_twin`;
    const replies = await Promise.all(peers.slice(0, 2).map((peer) => peer.call("cotal_connect", { name })));
    const handles = replies.map(handle);
    const names = replies.map((reply) => /Connected as ([^ .\n]+)/.exec(text(reply))?.[1]);
    console.log(`${tag} concurrent names: ${JSON.stringify(names)}`);
    check(`${tag}: simultaneous connects get one requested name and one reported suffix`,
      [...names].sort().join(",") === `${name},${name}_2` && replies.some((reply) => text(reply).includes(`("${name}" was taken)`)));
    const observerId = handle(await peers[2]!.call("cotal_connect", { name: `${tag}_observer` }));
    const dm = await peers[2]!.call("cotal_dm", { connection_id: observerId, to: name, text: "unambiguous name proof" });
    check(`${tag}: a third MCP process can DM the requested name`, !dm.result?.isError && dm.error === undefined);
    const winner = names.indexOf(name);
    const mail = await peers[winner]!.call("cotal_wait", { connection_id: handles[winner], seconds: 5 });
    check(`${tag}: the requested-name winner receives the DM`, !mail.result?.isError && text(mail).includes("unambiguous name proof"));
  } finally {
    for (const peer of peers) await peer.end();
  }
}

const persona = "---\nname: default\nsubscribe: [general]\nallowSubscribe: [general, team.>]\nallowPublish: [general]\ncapabilities: []\n---\n\nA local conversation.\n";
const staticSpace = `mcpstatic${process.pid}`;
const auth = await createSpaceAuth(staticSpace);
const broker = await bootBroker(auth);
let observer: InstanceType<typeof CotalEndpoint> | undefined;
let sender: InstanceType<typeof CotalEndpoint> | undefined;
let openBroker: ReturnType<typeof spawn> | undefined;
let releaseOpen: (() => void) | undefined;
try {
  for (const args of [["help"], ["help", "mcp"], ["mcp", "--help"]]) {
    const r = run(args);
    assert.ifError(r.error);
    check(`shipped ${args.join(" ")} succeeds and lists mcp`, r.status === 0 && /\bmcp\b/.test(r.stdout));
  }
  const chat = run(["chat", "--help"]);
  check("positive control chat --help still offers --stdio", chat.status === 0 && chat.stdout.includes("--stdio"));
  for (const args of [["mcp", "extra"], ["mcp", "--space", ""]]) {
    const r = run(args);
    check(`invalid MCP arguments are refused before serving (${JSON.stringify(args)})`, r.status !== 0 && r.stdout === "");
  }
  const root = join(scratch, "project");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", "default.md"), persona);
  saveSpaceAuth(authDir(root), auth);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space: staticSpace, creds: provisioner });
  await seedChannelRegistry({ servers: broker.servers, space: staticSpace, creds: provisioner, file: { channels: { general: { replay: false } } } });
  recordMesh({ space: staticSpace, server: broker.servers, root, mode: "auth", origin: "manual", ts: new Date().toISOString() });
  observer = new CotalEndpoint({ space: staticSpace, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "observer"), channels: [], card: { name: "probe", kind: "endpoint" }, consume: false, registerPresence: false });
  observer.on("error", () => {});
  await observer.start();
  sender = new CotalEndpoint({ space: staticSpace, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "operator"), channels: [], card: { name: "sender", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
  sender.on("error", () => {});
  await sender.start();

  await competingNames(staticSpace, "static");

  const rpc = new Rpc(staticSpace, "static");
  await rpc.initialize();
  const tools = (await rpc.request("tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
  check("the stock gateway advertises connect, wait, inbox and docs, not managed-seat authority", ["cotal_connect", "cotal_wait", "cotal_inbox", "cotal_docs"].every((t) => tools.includes(t)) && !tools.includes("cotal_spawn") && !tools.includes("cotal_yield"));
  check("initialize and tools/list create no identity", identities().length === 0);
  check("initialization never seeds connector packages", !existsSync(join(env.XDG_CONFIG_HOME!, "cotal", "seed")) && !existsSync(join(env.XDG_CONFIG_HOME!, "cotal", "extensions")));
  const connected = await rpc.call("cotal_connect", { name: "reader" });
  assert.equal(connected.result?.isError, undefined, text(connected));
  const handle = /connection_id: ([^\s]+)/.exec(text(connected))?.[1];
  assert.ok(handle, text(connected));
  check("cotal_connect returns a real connection and the persona channel grants", text(connected).includes("general") && identities().length === 1);
  await until(() => observer!.getRoster().some((p) => p.card.name === "reader"), "reader presence missing");
  const presence = observer.getRoster().find((p) => p.card.name === "reader")!;
  check("presence uses the mcp connector and one stable lifecycle", presence.card.meta?.connector === "mcp" && Boolean(presence.lifecycleUid));
  const who = presence.card.id;
  const evidence = await withIssuerSession({ servers: broker.servers, space: staticSpace, auth, tls: false }, async ({ jsm }) => {
    const bucket = issuedBucket(staticSpace);
    const msg = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.v1.${who}.${presence.lifecycleUid}.*` });
    assert.ok(msg, "issued evidence must exist");
    return JSON.parse(new TextDecoder().decode(msg.data)) as { ref: IssuedAuthorityRef; expiresAt?: number };
  });
  check("static credential issuance lasts to the terminal horizon, not 15 minutes", Number.parseInt(evidence.ref.generation.slice(0, 8), 16) === TERMINAL_SEAT_HORIZON_SEC && (evidence.expiresAt === undefined || evidence.expiresAt === TERMINAL_SEAT_HORIZON_SEC));
  writeFileSync(join(scratch, "issuance.json"), JSON.stringify(evidence, null, 2));
  check("missing connection handle cannot reach the mesh", Boolean((await rpc.call("cotal_roster")).result?.isError));
  check("foreign connection handle cannot reach the mesh", Boolean((await rpc.call("cotal_roster", { connection_id: "foreign" })).result?.isError));
  const duplicate = await rpc.call("cotal_connect", { name: "other" });
  check("one stdio process refuses a second live identity", Boolean(duplicate.result?.isError) && identities().length === 1);
  const status = await rpc.call("cotal_status", { connection_id: handle, attention: "dnd" });
  assert.ok(!status.result?.isError, text(status));
  const wait = rpc.call("cotal_wait", { connection_id: handle, seconds: 5 });
  await sleep(100);
  await sender.unicast(who, "direct wake proof");
  const woke = await wait;
  check("cotal_wait wakes on a real DM without chat or a polling loop", !woke.result?.isError && text(woke).includes("direct wake proof"));
  await sender.multicast("mention wake proof", { channel: "general", mentions: ["reader"] });
  const mention = await rpc.call("cotal_wait", { connection_id: handle, seconds: 5 });
  check("cotal_wait also wakes on a real channel mention in dnd", !mention.result?.isError && text(mention).includes("mention wake proof"));
  const roster = await rpc.call("cotal_roster", { connection_id: handle });
  const active = observer.getRoster().filter((p) => p.card.name === "reader" && p.status !== "offline");
  check("messaging preserves the original principal and lifecycle", !roster.result?.isError && active.length === 1 && active[0]!.card.id === who && active[0]!.lifecycleUid === presence.lifecycleUid);
  const disconnected = await rpc.call("cotal_disconnect", { connection_id: handle });
  check("explicit disconnect retires and removes its local identity", !disconnected.result?.isError && identities().length === 0);
  const retired = await withIssuerSession({ servers: broker.servers, space: staticSpace, auth, tls: false }, async ({ jsm }) => {
    const bucket = issuedBucket(staticSpace);
    const msg = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${issuedAttemptKey(evidence.ref)}` });
    assert.ok(msg, "issued attempt must exist");
    return JSON.parse(new TextDecoder().decode(msg.data)) as { state: string };
  });
  check("disconnect revokes the broker-side issuance", retired.state === "revoked");
  check("a disconnected handle cannot be reused", Boolean((await rpc.call("cotal_roster", { connection_id: handle })).result?.isError));
  await rpc.end();

  for (const signal of [undefined, "SIGINT", "SIGTERM"] as const) {
    const server = new Rpc(staticSpace, `exit-${signal ?? "eof"}`);
    await server.initialize();
    const reply = await server.call("cotal_connect", { name: `exit_${signal ?? "eof"}` });
    assert.ok(!reply.result?.isError, text(reply));
    assert.equal(identities().length, 1);
    await server.end(signal);
    check(`${signal ?? "stdin EOF"} finishes owned identity cleanup`, identities().length === 0);
  }
  const survivor = new Rpc(staticSpace, "survivor");
  const killed = new Rpc(staticSpace, "killed");
  await survivor.initialize();
  await killed.initialize();
  assert.ok(text(await survivor.call("cotal_connect", { name: "alice" })).includes("Connected as alice"));
  assert.ok(text(await killed.call("cotal_connect", { name: "bob" })).includes("Connected as bob"));
  await until(() => observer!.getRoster().some((p) => p.card.name === "bob" && p.status !== "offline"), "bob presence missing");
  const abandoned = identities();
  killed.child.kill("SIGKILL");
  await killed.exited;
  await sleep(3_000);
  const restarted = new Rpc(staticSpace, "restarted");
  await restarted.initialize();
  const reclaimed = text(await restarted.call("cotal_connect", { name: "bob" }));
  console.log(`Restart result: ${reclaimed}`);
  check("a killed conversation host reclaims its name immediately", reclaimed.startsWith("Connected as bob.\n") && !reclaimed.includes("was taken"));
  check("restart retires only the abandoned identity", identities().length === 2 && abandoned.filter((dir) => identities().includes(dir)).length === 1);
  const collision = new Rpc(staticSpace, "collision");
  await collision.initialize();
  const occupied = text(await collision.call("cotal_connect", { name: "alice" }));
  check("a live conversation still owns its name", occupied.includes("Connected as alice_2") && occupied.includes("was taken"));
  await collision.end();
  await restarted.end();
  await survivor.end();

  const narrowed = new Rpc(staticSpace, "narrow");
  await narrowed.initialize();
  const bad = await narrowed.call("cotal_connect", { name: "limited", channels: [{ channel: "forbidden", access: "read-post" }] });
  check("connect refuses permissions outside the persona without issuing an identity", Boolean(bad.result?.isError) && identities().length === 0);
  await narrowed.end();

  const openSpace = `mcpopen${process.pid}`;
  const port = await freePort();
  const store = mkdtempSync(join(env.TMPDIR!, SMOKE_BROKER_TOKEN));
  openBroker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", store], { stdio: "ignore" });
  releaseOpen = teardownOnSignal(openBroker, store);
  const servers = `nats://127.0.0.1:${port}`;
  await until(async () => openBroker!.exitCode === null && await isReachable(servers), "owned open broker did not start");
  await setupSpaceStreams({ servers, space: openSpace });
  recordMesh({ space: openSpace, server: servers, root, mode: "open", origin: "manual", ts: new Date().toISOString() });
  await competingNames(openSpace, "open");
  const open = new Rpc(openSpace, "open");
  await open.initialize();
  const openReply = await open.call("cotal_connect", { name: "reader" });
  check("an open mesh also connects through the shipped command", !openReply.result?.isError && Boolean(/connection_id:/.test(text(openReply))));
  await open.end();
  check("open-mesh EOF removes its identity record", identities().length === 0);

  const userSpace = `mcpuser${process.pid}`;
  recordMesh({ space: userSpace, server: servers, root, mode: "user", origin: "manual", ts: new Date().toISOString(),
    userAuth: { provider: "cotal", idp: { url: "https://example.invalid", issuer: "https://example.invalid", audience: "cotal" }, endpoints: { url: "https://example.invalid" } } });
  const user = new Rpc(userSpace, "user");
  await user.initialize();
  const refused = await user.call("cotal_connect", { name: "reader" });
  check("signed-in spaces refuse instead of inventing native session identity", Boolean(refused.result?.isError) && /native conversation identity/.test(text(refused)) && identities().length === 0);
  await user.end();
  console.log(`Evidence retained at ${scratch}`);
} finally {
  for (const rpc of children) await killAndAwaitExit(rpc.child);
  await sender?.stop();
  await observer?.stop();
  if (openBroker) await killAndAwaitExit(openBroker);
  releaseOpen?.();
  await broker.stop();
}
finish();
