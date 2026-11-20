/**
 * LIVE: Claude Code's tool permissions on the agent endpoint (SPEC 13.21, 13.22), against a real
 * Claude Code with no Manager running.
 *
 * It proves that in a Claude session Cotal launched, an authorized person can see and answer Claude's
 * tool-permission prompt over the session's own `agent` endpoint while Claude's dialog stays open, that
 * every state a prompt reaches is one the Claude adapter's card table names, and that nothing about a
 * prompt is stored on the broker.
 *
 * The launch is the material a Manager would hand over, set by hand. A real nats-server runs in
 * operator mode with the shipped auth callout, which trusts a test issuer this suite signs bearers
 * with. The seat is a managed agent whose durables are provisioned and whose argv and env come from
 * the shipped `claudeConnector.buildLaunch` with `userAuth`; `claude` runs under a PTY in the default
 * permission mode. The answering side is alice's interactive session `web`, calling `prompts`,
 * `prompt` and `prompt-answer` through `CotalEndpoint.callPrincipal`. The terminal side is keys
 * written to Claude's PTY.
 *
 * Test-only seams, none in shipped code:
 * - Claude loads a copy of the plugin whose `hooks.json` is the shipped one with each command routed
 *   through a shim. The shim sends the event to this suite and then runs the shipped `dist/hook.cjs`
 *   in its own process, so killing the shim kills that hook. On instruction the shim holds an event,
 *   drops it, defers it (Claude goes on and the suite relays the event later through the shipped hook),
 *   rewrites it, or lets the hook print its output and kills it before the relay's receipt.
 * - The expiry case starts the seat with a preload that runs long timers every second and moves the
 *   seat's clock past `expiresAt` on SIGUSR2, so the shipped 7-day `openMs` ends in seconds.
 *
 * Claude's login is CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY when set, else the access token from
 * the operator's Claude credentials file, never its refresh token. It travels only in the child env and
 * is never written or printed. HOME, CLAUDE_CONFIG_DIR, COTAL_HOME and the XDG dirs are scratch, and
 * nothing is written to the operator's own config. The model is haiku (CLAUDE_PROMPTS_MODEL), each case
 * asks for one or two `touch` calls, and CLAUDE_PROMPTS_CASES=a,b runs a subset. Evidence (every hook
 * event, every prompt state with its card, screens) goes to CLAUDE_PROMPTS_LOG_DIR when set. Kills only
 * what it starts.
 *
 * Run: pnpm smoke:claude-permission-prompts:live   (needs claude and nats-server on PATH; `pnpm build` first)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import {
  AGENT_ENDPOINT, CotalEndpoint, createSpaceAuth, epPrincipalRequestSubject, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, provisionAgentDurables, serverConfig, setupSpaceStreams,
  type AgentPrompt, type EndpointReply, type EpPrincipal, type Presence, type PromptState, type PromptSummary, type PromptsOutput,
} from "@cotal-ai/core";
import { calloutPermissions, createCalloutAuth, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver } from "@cotal-ai/auth";
import { claudeConnector } from "@cotal-ai/connector-claude-code";
import { SMOKE_BROKER_TOKEN, createSuite, freePort, killAndAwaitExit, skipSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..");
const PLUGIN_ROOT = join(WT, "extensions", "connector-claude-code");
const HOOK = join(PLUGIN_ROOT, "dist", "hook.cjs");
const SEAT_ENTRY = join(PLUGIN_ROOT, "dist", "seat.cjs");
const MODEL = process.env.CLAUDE_PROMPTS_MODEL?.trim() || "haiku";
const ONLY = new Set((process.env.CLAUDE_PROMPTS_CASES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const LOG_DIR = process.env.CLAUDE_PROMPTS_LOG_DIR?.trim() || undefined;
const COLS = 200, ROWS = 50;

const { check, finish, passed, failed } = createSuite();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const clock = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
async function until<T>(get: () => T | undefined | false | Promise<T | undefined | false>, ms: number, every = 100): Promise<T | undefined> {
  for (const end = Date.now() + ms; ; await wait(every)) {
    const v = await get();
    if (v) return v;
    if (Date.now() > end) return undefined;
  }
}

// ---- preconditions --------------------------------------------------------------------------------

for (const [bin, args] of [["claude", ["--version"]], ["nats-server", ["--version"]]] as const) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) skipSuite(`${bin} is not on PATH`);
  console.log(`${bin}: ${r.stdout.trim()}`);
}
for (const built of [HOOK, SEAT_ENTRY]) if (!existsSync(built)) throw new Error(`${built} is missing: run pnpm build first`);

/** Claude's credential, taken before the environment is cleared. Never printed. */
function claudeCredential(): Record<string, string> | undefined {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN.trim() };
  if (process.env.ANTHROPIC_API_KEY?.trim()) return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY.trim() };
  const file = join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), ".credentials.json");
  try {
    const oauth = (JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth;
    if (oauth?.accessToken && (oauth.expiresAt ?? Infinity) > Date.now() + 30 * 60_000) return { CLAUDE_CODE_OAUTH_TOKEN: oauth.accessToken };
  } catch { /* no file */ }
  return undefined;
}
const credential = claudeCredential();
if (!credential) skipSuite("no Claude credential: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or log in to claude");

// ---- scratch, and the environment buildLaunch reads ---------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cotal-claude-prompts-")));
const dir = (...p: string[]) => {
  const d = join(scratch, ...p);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const home = dir("home"), claudeConfig = dir("claude"), cotalHome = dir("cotal"), work = dir("work");
for (const k of Object.keys(process.env))
  if (k.startsWith("COTAL_") || k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC_") || k === "NODE_OPTIONS") delete process.env[k];
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: dir("xdg", "config"), XDG_DATA_HOME: dir("xdg", "data"),
  XDG_STATE_HOME: dir("xdg", "state"), XDG_CACHE_HOME: dir("xdg", "cache"), COTAL_HOME: cotalHome, CLAUDE_CONFIG_DIR: claudeConfig,
  ...credential,
});
// A profile that has run Claude once, with the work directory trusted.
writeFileSync(join(claudeConfig, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", projects: { [work]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });

/** Launch artifacts of seats still open. On any exit, these and the scratch directory are removed. */
const artifacts = new Set<string>();
process.on("exit", () => {
  for (const a of artifacts) rmSync(a, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const logs = new Map<string, string>();
function log(name: string, line: string): void {
  const text = `${clock()} ${line}`;
  console.log(`    ${text}`);
  if (!LOG_DIR) return;
  mkdirSync(LOG_DIR, { recursive: true });
  let file = logs.get(name);
  if (!file) logs.set(name, (file = join(LOG_DIR, `${name}.log`)));
  appendFileSync(file, `${text}\n`);
}

// ---- the mesh: nats-server, the shipped auth callout, alice's web session ------------------------

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `prompts-${Math.random().toString(36).slice(2, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(brokerDir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port: PORT, storeDir: join(brokerDir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
}));
const broker: ChildProcess = spawn("nats-server", ["-c", join(brokerDir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, brokerDir);

const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
const ISS = "https://issuer.prompts.test";
const A = deriveOwnerToken("s".repeat(32), "test|alice");
interface Who { owner: string; actor: string; uid: string; kind: "interactive" | "managed-agent" }
const ledger = new Map<string, Who>();
const resolveAcl: AclResolver = (t) => {
  const w = ledger.get(t.act.lifecycleUid!);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [], allowPublish: [], lifecycleUid: w.uid, scope: [], kind: w.kind };
};
const bearerFor = async (w: Who): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: w.owner, ver: USER_TOKEN_VER, act: { owner: w.owner, actor: w.actor, scope: [], lifecycleUid: w.uid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(w.owner)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 780).sign(privateKey as CryptoKey);
};
// The seat's bearer command signs the same token in its own process, from a key the suite hands it.
const bearerDir = dir("bearer");
writeFileSync(join(bearerDir, "key.json"), JSON.stringify(await exportJWK(privateKey)), { mode: 0o600 });
writeFileSync(join(bearerDir, "bearer.mjs"), `import { readFileSync } from "node:fs";
import { SignJWT, importJWK } from ${JSON.stringify(import.meta.resolve("jose"))};
const who = JSON.parse(readFileSync(process.argv[2], "utf8"));
const key = await importJWK(JSON.parse(readFileSync(${JSON.stringify(join(bearerDir, "key.json"))}, "utf8")), "EdDSA");
const now = Math.floor(Date.now() / 1000);
process.stdout.write(await new SignJWT({ sub: who.owner, ver: ${USER_TOKEN_VER}, act: { owner: who.owner, actor: who.actor, scope: [], lifecycleUid: who.uid } })
  .setProtectedHeader({ alg: "EdDSA" }).setIssuer(${JSON.stringify(ISS)}).setAudience(${JSON.stringify(space)}).setSubject(who.owner)
  .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 780).sign(key));
`);
const sentinelPath = join(bearerDir, "sentinel.creds");
writeFileSync(sentinelPath, callout.sentinelCreds, { mode: 0o600 });

for (let i = 0; i < 50 && !(await isReachable(SERVERS)); i++) await wait(200);
await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
/** Provision a seat's durables with a provisioner credential of its own: the credential is short-lived. */
async function provision(w: Who): Promise<void> {
  const ep = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "provisioner"), card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  ep.on("error", () => {});
  ep.on("warning", () => {});
  await ep.start();
  try {
    await provisionAgentDurables(ep as never, { owner: w.owner, actor: w.actor, lifecycleUid: w.uid }, { durableMembership: false });
  } finally {
    await ep.stop();
  }
}
const calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(callout.calloutCreds)) });
startAuthCallout(calloutNc as never, {
  xkeySeed: callout.xkey.seed,
  authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
  dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
  space,
  token: { key: publicKey as never, issuer: ISS },
  recordIssuance: async () => {},
  authorizeActor: () => {},
  permissionsFor: calloutPermissions(resolveAcl, async () => {}),
  log: (l) => { if (/denied|drop|fail/i.test(l)) console.log("  [callout]", l); },
});
const WEB: Who = { owner: A, actor: "web", uid: mintLifecycleUid(), kind: "interactive" };
ledger.set(WEB.uid, WEB);
const web = new CotalEndpoint({
  space, servers: SERVERS, bearer: () => bearerFor(WEB), sentinelCreds: callout.sentinelCreds, lifecycleUid: WEB.uid,
  card: { owner: WEB.owner, actor: WEB.actor, name: WEB.actor, kind: "agent" }, channels: [], consume: false, watchChannels: false,
  registerPresence: false, watchPresence: true,
});
web.on("error", () => {});
web.on("warning", () => {});
await web.start();

// ---- the hook hub: every hook event Claude fires, through the shim --------------------------------

type HookEvent = Record<string, unknown> & { hook_event_name?: string; agent_id?: string; tool_name?: string; tool_input?: unknown; tool_calls?: unknown };
type Action = "pass" | "drop" | "defer" | "hold" | "die-after-write" | { rewrite: (ev: HookEvent) => HookEvent };
/** One hook process: what Claude sent, what the suite told the shim, and how the process ended. */
interface HookRun {
  seq: number;
  actor: string;
  event: HookEvent;
  raw: string;
  env: Record<string, string>;
  pid: number;
  action: string;
  /** Set when the process ended: what it printed, and its exit code (undefined when a signal killed it). */
  ended?: { out: string; code?: number };
  done: Promise<void>;
  /** A run the suite started itself, to relay a deferred event late. */
  replayOf?: number;
}
interface Rule { actor: string; match: (ev: HookEvent) => boolean; action: Action; left: number; hits: HookRun[]; gates: Gate[] }
/** A held or deferred event: `release` lets it go on, and resolves once its hook process ended. */
interface Gate { run: HookRun; release(): Promise<HookRun> }

const shimDir = dir("shim");
const hubSock = join(shimDir, "hub.sock");
const runs: HookRun[] = [];
const rules: Rule[] = [];
let runSeq = 0;
const describeEvent = (ev: HookEvent): string => {
  const scope = typeof ev.agent_id === "string" ? `agent ${String(ev.agent_id).slice(0, 8)}` : "main";
  const bits = [String(ev.hook_event_name), `[${scope}]`];
  if (typeof ev.tool_name === "string") bits.push(ev.tool_name, JSON.stringify(ev.tool_input).slice(0, 140));
  if (Array.isArray(ev.tool_calls)) bits.push(`tool_calls=${JSON.stringify(ev.tool_calls).slice(0, 400)}`);
  if (typeof ev.notification_type === "string") bits.push(String(ev.notification_type));
  if (typeof ev.error === "string") bits.push(`error=${String(ev.error)}`);
  return bits.join(" ");
};
const runLabel = new Map<string, string>(); // actor -> case name, for the log
function finishRun(run: HookRun, outFile: string, exitFile: string): void {
  const out = existsSync(outFile) ? readFileSync(outFile, "utf8").trim() : "";
  const code = existsSync(exitFile) ? Number(readFileSync(exitFile, "utf8")) : undefined;
  run.ended = { out, code };
  log(runLabel.get(run.actor) ?? "hub", `hook #${run.seq} ${run.event.hook_event_name} ended: ${code === undefined ? "killed" : `exit ${code}`}, printed ${out ? out.slice(0, 200) : "nothing"}`);
}
const hub = createServer((c: Socket) => {
  let buf = "";
  let run: HookRun | undefined;
  let ended!: () => void;
  const done = new Promise<void>((r) => (ended = r));
  c.setEncoding("utf8");
  c.on("error", () => {});
  c.on("data", (d: string) => {
    if (run) return;
    buf += d;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    let msg: { pid: number; raw: string; env: Record<string, string> };
    try {
      msg = JSON.parse(buf.slice(0, nl)) as typeof msg;
    } catch {
      return void c.write(`${JSON.stringify({ action: "pass" })}\n`);
    }
    let event: HookEvent = {};
    try { event = JSON.parse(msg.raw) as HookEvent; } catch { /* malformed: relayed as is */ }
    const seq = ++runSeq;
    run = { seq, actor: msg.env.COTAL_NAME ?? "?", event, raw: msg.raw, env: msg.env, pid: msg.pid, action: "pass", done };
    runs.push(run);
    const outFile = join(shimDir, `${seq}.out`), exitFile = join(shimDir, `${seq}.exit`);
    const r = run;
    c.on("close", () => { finishRun(r, outFile, exitFile); ended(); });
    const rule = rules.find((x) => x.left > 0 && x.actor === r.actor && x.match(event));
    let reply: Record<string, unknown> = { action: "pass" };
    if (rule) {
      rule.left--;
      rule.hits.push(r);
      const a = rule.action;
      if (typeof a === "object") {
        const ev = a.rewrite(event);
        reply = { action: "pass", raw: JSON.stringify(ev) };
        r.action = `rewrite to ${describeEvent(ev).slice(0, 120)}`;
        r.event = ev;
      } else r.action = a;
      if (a === "drop" || a === "defer") reply = { action: "exit" };
      if (a === "die-after-write") reply = { action: "die-after-write" };
      if (a === "defer") rule.gates.push({ run: r, release: () => replay(r) });
      if (a === "hold") {
        let released: Promise<HookRun> | undefined;
        rule.gates.push({ run: r, release: () => (released ??= (c.write(`${JSON.stringify({ action: "pass", outFile, exitFile })}\n`), r.done.then(() => r))) });
      }
    }
    log(runLabel.get(r.actor) ?? "hub", `hook #${seq} pid ${msg.pid} ${describeEvent(r.event)} -> ${r.action}`);
    if (r.action !== "hold") c.write(`${JSON.stringify({ ...reply, outFile, exitFile })}\n`);
  });
});
await new Promise<void>((res) => hub.listen(hubSock, res));

/** Relay a deferred event now, through the shipped hook in a process of its own, with the env Claude
 *  gave the original hook. */
function replay(of: HookRun): Promise<HookRun> {
  const child = spawn(process.execPath, [HOOK], { env: of.env, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
  const run: HookRun = { seq: ++runSeq, actor: of.actor, event: of.event, raw: of.raw, env: of.env, pid: child.pid ?? 0, action: "late relay", replayOf: of.seq, done: Promise.resolve() };
  runs.push(run);
  log(runLabel.get(run.actor) ?? "hub", `hook #${run.seq} relays #${of.seq} (${of.event.hook_event_name}) late`);
  run.done = new Promise<void>((res) => child.on("close", (code) => {
    run.ended = { out: out.trim(), code: code ?? undefined };
    log(runLabel.get(run.actor) ?? "hub", `hook #${run.seq} ended: exit ${code}, printed ${out.trim() || "nothing"}`);
    res();
  }));
  child.stdin!.end(of.raw);
  return run.done.then(() => run);
}

/** The shim: the hook command of the plugin copy. It reads the event, asks the hub, and runs the
 *  shipped hook in this same process, with the event as its stdin. */
const SHIM = join(shimDir, "shim.cjs");
writeFileSync(SHIM, `"use strict";
const net = require("node:net"), fs = require("node:fs"), { Readable } = require("node:stream");
const [sock, hook] = process.argv.slice(2);
const keep = (k) => k.startsWith("COTAL_") || k.startsWith("CLAUDE_PLUGIN_") || ["PATH", "HOME", "TMPDIR"].includes(k);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep(k)));
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  let decided = false, buf = "";
  const c = net.connect(sock);
  const go = (d) => { if (decided) return; decided = true; run(d, raw); };
  c.on("connect", () => c.write(JSON.stringify({ pid: process.pid, raw, env }) + "\\n"));
  c.on("data", (d) => { buf += d; const i = buf.indexOf("\\n"); if (i >= 0) go(JSON.parse(buf.slice(0, i))); });
  c.on("error", () => go({ action: "pass" }));
  function run(d, raw) {
    if (d.action === "exit") process.exit(0);
    c.unref();
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, enc, cb) => {
      if (typeof enc === "function") { cb = enc; enc = undefined; }
      if (d.outFile) try { fs.appendFileSync(d.outFile, chunk); } catch {}
      if (d.action === "die-after-write") return write(chunk, enc, () => process.kill(process.pid, "SIGKILL"));
      return write(chunk, enc, cb);
    };
    if (d.exitFile) process.on("exit", (code) => { try { fs.writeFileSync(d.exitFile, String(code)); } catch {} });
    Object.defineProperty(process, "stdin", { value: Readable.from([Buffer.from(d.raw ?? raw)], { objectMode: false }), configurable: true });
    require(hook);
  }
});
`);

/** A copy of the shipped plugin whose hook commands go through the shim. `seatArgs` are the node
 *  arguments of its MCP server, the same as the launch's `--mcp-config` entry so Claude runs one. */
function pluginCopy(name: string, seatArgs: string[]): string {
  const root = dir("plugins", name);
  for (const part of [".claude-plugin", "hooks", "monitors", "skills-plugin"]) cpSync(join(PLUGIN_ROOT, part), join(root, part), { recursive: true });
  symlinkSync(join(PLUGIN_ROOT, "dist"), join(root, "dist"));
  const shipped = 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.cjs"';
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  for (const groups of Object.values(hooks.hooks))
    for (const g of groups)
      for (const h of g.hooks) {
        if (h.command !== shipped) throw new Error(`the shipped hooks.json has a command this suite does not route: ${h.command}`);
        h.command = `node "${SHIM}" "${hubSock}" "\${CLAUDE_PLUGIN_ROOT}/dist/hook.cjs"`;
      }
  writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify(hooks, null, 2));
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { cotal: { command: "node", args: seatArgs } } }, null, 2));
  return root;
}
const SEAT_ARGS = ["--optimize-for-size", "--max-semi-space-size=1", SEAT_ENTRY];
const plugin = pluginCopy("shimmed", SEAT_ARGS);

// ---- a seat: one real Claude Code, launched from the shipped launch material ------------------------

interface Pty { pid: number; write(d: string): void; kill(sig?: string): void; onData(cb: (d: string) => void): unknown; onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown }
interface XTerm { write(d: string): void; buffer: { active: { baseY: number; getLine(i: number): { translateToString(trim?: boolean): string } | undefined } } }
const seatRequire = createRequire(join(WT, "packages", "seat", "package.json"));
const nodePty = seatRequire("@lydell/node-pty") as { spawn(file: string, args: string[], o: Record<string, unknown>): Pty };
const { Terminal } = seatRequire("@xterm/headless") as { Terminal: new (o: Record<string, unknown>) => XTerm };

interface Seat {
  name: string;
  actor: string;
  uid: string;
  principal: EpPrincipal;
  screen(): string;
  waitScreen(re: RegExp, ms?: number): Promise<boolean>;
  /** Type `text` into Claude's input and submit it. */
  say(text: string): Promise<void>;
  key(k: string): void;
  snap(label: string): void;
  /** Presence of this seat as alice's session sees it. */
  presence(): Presence | undefined;
  close(): Promise<void>;
}
const KEY = { enter: "\r", esc: "\x1b", down: "\x1b[B", shiftTab: "\x1b[Z" };
const READY = ["? for shortcuts", "(shift+tab to cycle)"];
let seatSeq = 0;
const open: Seat[] = [];

async function launch(name: string, o: { launchOptions?: Record<string, unknown>; plugin?: string; seatArgs?: string[] } = {}): Promise<Seat> {
  const actor = `pp${++seatSeq}`;
  runLabel.set(actor, name);
  const who: Who = { owner: A, actor, uid: mintLifecycleUid(), kind: "managed-agent" };
  ledger.set(who.uid, who);
  await provision(who);
  const whoFile = join(bearerDir, `${actor}.json`);
  writeFileSync(whoFile, JSON.stringify(who), { mode: 0o600 });
  const spec = claudeConnector.buildLaunch({
    space, name: actor, servers: SERVERS, lifecycleUid: who.uid, model: MODEL, events: false,
    userAuth: { owner: who.owner, actor: who.actor, sentinelCredsPath: sentinelPath, bearerCmd: [process.execPath, join(bearerDir, "bearer.mjs"), whoFile] },
    // The account's own default can be auto mode, which asks nothing. Every case runs in default mode
    // unless it names another, the way an operator passes `--opt permission-mode=<mode>`.
    launchOptions: { "permission-mode": "default", ...o.launchOptions },
  });
  for (const a of spec.artifacts ?? []) artifacts.add(a);
  const args = [...spec.args];
  const pd = args.indexOf("--plugin-dir");
  if (pd < 0 || resolve(args[pd + 1]!) !== resolve(PLUGIN_ROOT)) throw new Error(`buildLaunch no longer loads the plugin from ${PLUGIN_ROOT}: ${args.join(" ")}`);
  args[pd + 1] = o.plugin ?? plugin;
  if (o.seatArgs) {
    const mc = args.indexOf("--mcp-config");
    const cfg = JSON.parse(args[mc + 1]!) as { mcpServers: Record<string, { args: string[] }> };
    cfg.mcpServers.cotal!.args = o.seatArgs;
    args[mc + 1] = JSON.stringify(cfg);
  }
  log(name, `launch ${actor}: claude ${args.map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)).join(" ")}`);
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const p = nodePty.spawn(spec.command, args, { name: "xterm-256color", cols: COLS, rows: ROWS, cwd: work, env: { ...spec.env, DISABLE_AUTOUPDATER: "1" } });
  let exited = false;
  const exit = new Promise<void>((r) => p.onExit(() => { exited = true; r(); }));
  p.onData((d) => term.write(d));
  const screen = (): string => {
    const b = term.buffer.active;
    const lines: string[] = [];
    for (let i = b.baseY; i < b.baseY + ROWS; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n");
  };
  const presence = () => web.getRoster().find((x) => x.card.id === `${A}.${actor}` && x.lifecycleUid === who.uid);
  const seat: Seat = {
    name, actor, uid: who.uid, principal: undefined as unknown as EpPrincipal, screen, presence,
    waitScreen: async (re, ms = 60_000) => (await until(() => re.test(screen()), ms, 150)) === true,
    say: async (text) => {
      p.write(text);
      await wait(400);
      p.write(KEY.enter);
    },
    key: (k) => p.write(k),
    snap: (label) => {
      if (!LOG_DIR) return;
      appendFileSync(join(LOG_DIR, `${name}.screens.txt`), `===== ${clock()} ${label}\n${screen().replace(/\n+$/, "")}\n\n`);
    },
    close: async () => {
      if (!exited) {
        p.kill("SIGTERM");
        await Promise.race([exit, wait(10_000)]);
        if (!exited) p.kill("SIGKILL");
        await Promise.race([exit, wait(5_000)]);
      }
      for (const a of spec.artifacts ?? []) {
        rmSync(a, { recursive: true, force: true });
        artifacts.delete(a);
      }
      open.splice(open.indexOf(seat), 1);
    },
  };
  open.push(seat);
  // Claude's startup: the development-channels gate the launch flag raises, then its input screen.
  let gated = false;
  const ready = await until(() => {
    const s = screen();
    if (/Select login method|Choose the text style/.test(s)) throw new Error(`Claude stopped on a setup screen:\n${s}`);
    if (!gated && s.includes("WARNING: Loading development channels")) {
      gated = true;
      p.write(KEY.enter);
    }
    return READY.some((r) => s.includes(r));
  }, 90_000, 200);
  if (!ready) {
    seat.snap("startup timed out");
    throw new Error(`Claude did not reach its input screen:\n${screen()}`);
  }
  const served = await until(() => {
    const x = presence();
    return x?.prompts !== undefined && x.runtime ? x : undefined;
  }, 60_000, 200);
  if (!served) throw new Error(`${actor} never showed a served agent endpoint in presence`);
  seat.principal = { owner: A, actor, uid: who.uid, runtimeId: served.runtime!.id };
  log(name, `${actor} is up: Claude at its input screen, the agent endpoint served (runtime ${served.runtime!.id.slice(0, 8)})`);
  return seat;
}

// ---- the answering side: alice's web session over the agent endpoint -------------------------------

const call = (s: Seat, command: string, args: Record<string, unknown>): Promise<EndpointReply> =>
  web.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: s.principal, command, authority: "owner", args, deadlineMs: 20_000 });
async function list(s: Seat): Promise<PromptsOutput> {
  const r = await call(s, "prompts", {});
  if (!r.ok) throw new Error(`prompts was refused: ${r.error.code} ${r.error.message}`);
  return r.data as PromptsOutput;
}
async function read(s: Seat, id: string): Promise<AgentPrompt> {
  const r = await call(s, "prompt", { id });
  if (!r.ok) throw new Error(`prompt was refused: ${r.error.code} ${r.error.message}`);
  return (r.data as { prompt: AgentPrompt }).prompt;
}

/** The card the Claude adapter's table gives a state, or undefined for a state outside the table. */
function card(s: PromptState): string | undefined {
  if (s.kind === "open") return "(open)";
  const verb = (option: string) => (option === "allow" ? "Allow" : "Deny");
  if (s.kind === "sent") return `${verb(s.answer.option)} ${s.delivery === "delivered" ? "handed to Claude." : "submitted."}`;
  const o = s.outcome;
  const subject = (seen: { tie: string; effect?: string }) => seen.tie === "subject" && seen.effect === "proceed";
  switch (o.kind) {
    case "unconfirmed":
      if (subject(o.seen)) return `${verb(o.answer.option)} submitted. A matching call was observed. It may belong to another request.`;
      if (o.seen.tie === "none") return o.answer.option === "allow" ? "Allow submitted." : "Deny submitted. No result was observed.";
      return undefined;
    case "withdrawn":
      if (subject(o.seen)) return "A matching call was observed on the machine. Remote answering ended.";
      if (o.seen.tie === "none") return "Remote answering ended. No result was observed.";
      return undefined;
    case "undelivered":
      return "Your answer was accepted but not handed over. The hook connection had already ended.";
    case "expired":
      return "Remote answering ended. Nobody answered from here in 7 days.";
    default:
      return undefined;
  }
}
function show(s: PromptState | undefined): string {
  if (!s) return "none";
  if (s.kind === "open") return "open";
  if (s.kind === "sent") return `sent/${s.delivery}(${s.answer.option})`;
  const o = s.outcome as { kind: string; seen?: { tie: string; effect?: string }; answer?: { option: string } };
  return `closed/${o.kind}${o.answer ? `(${o.answer.option})` : ""}${o.seen ? `/${o.seen.tie}${o.seen.effect ? `:${o.seen.effect}` : ""}` : ""}`;
}
/** Every state each prompt was seen in, in order, and whether each had a card. */
const timelines = new Map<string, { seat: Seat; states: string[] }>();
const offTable: string[] = [];
function note(s: Seat, id: string, state: PromptState | undefined): void {
  if (!state) return;
  const t = timelines.get(id) ?? { seat: s, states: [] };
  timelines.set(id, t);
  const label = show(state);
  if (t.states.at(-1) === label) return;
  t.states.push(label);
  const c = card(state);
  if (c === undefined) offTable.push(`${s.name} ${id.slice(0, 8)} ${label}`);
  log(s.name, `prompt ${id.slice(0, 8)}: ${label} | card: ${c ?? "NONE (outside the card table)"}`);
}
async function stateOf(s: Seat, id: string): Promise<PromptState | undefined> {
  const l = await list(s);
  const state = [...l.open, ...l.closed].find((x) => x.id === id)?.state;
  note(s, id, state);
  return state;
}
async function waitState(s: Seat, id: string, pred: (st: PromptState) => boolean, ms = 60_000): Promise<PromptState | undefined> {
  let last: PromptState | undefined;
  await until(async () => {
    last = await stateOf(s, id);
    return last !== undefined && pred(last);
  }, ms, 250);
  return last;
}
/** A value as canonical JSON (sorted keys), to compare tool inputs. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x);
interface Opened { p: PromptSummary; full: AgentPrompt; hook: HookRun | undefined }
/** Wait for a prompt that was not open before, and return it with the hook process that holds it. */
async function waitOpen(s: Seat, before: ReadonlySet<string> = new Set(), ms = 90_000): Promise<Opened> {
  const p = await until(async () => (await list(s)).open.find((x) => !before.has(x.id)), ms, 250);
  if (!p) {
    s.snap("no prompt opened");
    throw new Error(`${s.name}: no prompt opened. Screen:\n${s.screen()}`);
  }
  note(s, p.id, p.state);
  const full = await read(s, p.id);
  const input = (full.content.subject as { input: { kind: string; value?: unknown } }).input;
  const hook = [...runs].reverse().find((r) => r.actor === s.actor && r.event.hook_event_name === "PermissionRequest" && r.replayOf === undefined &&
    (input.kind !== "shown" || canon(r.event.tool_input) === canon(input.value)));
  return { p, full, hook };
}
async function answer(s: Seat, p: PromptSummary, option: string, note?: string): Promise<EndpointReply> {
  const r = await call(s, "prompt-answer", { id: p.id, digest: p.digest, option, ...(note !== undefined ? { note } : {}) });
  log(s.name, `answer ${option}${note ? ` (${note})` : ""} to ${p.id.slice(0, 8)}: ${r.ok ? `ok, ${show((r.data as { state: PromptState }).state)}` : `${r.error.code}/${r.error.outcome}`}`);
  return r;
}
const replyState = (r: EndpointReply): PromptState | undefined => (r.ok ? (r.data as { state: PromptState }).state : undefined);

const isOpen = (st?: PromptState) => st?.kind === "open";
const isSent = (st: PromptState | undefined, option: string, delivery?: "unconfirmed" | "delivered") =>
  st?.kind === "sent" && st.answer.option === option && (delivery === undefined || st.delivery === delivery);
const closedAs = (st: PromptState | undefined, kind: string, seen?: "none" | "subject", option?: string): boolean => {
  if (st?.kind !== "closed" || st.outcome.kind !== kind) return false;
  const o = st.outcome as { seen?: { tie: string; effect?: string }; answer?: { option: string } };
  if (seen === "none" && o.seen?.tie !== "none") return false;
  if (seen === "subject" && !(o.seen?.tie === "subject" && o.seen.effect === "proceed")) return false;
  return option === undefined || o.answer?.option === option;
};

// ---- Claude's side ----------------------------------------------------------------------------------

const DIALOG = /Do you want to proceed\?/;
const touch = (file: string) => `Run exactly this bash command and nothing else, then reply with the single word done: touch ${file}`;
/** Every file a case asks Claude to touch: unique names the broker scan looks for. */
const targets: string[] = [];
const target = (tag: string) => {
  const name = `${tag}-${Math.random().toString(36).slice(2, 8)}`;
  targets.push(name);
  return join(work, name);
};
/** Press the option of Claude's open dialog whose label starts with `label`. */
function choose(s: Seat, label: RegExp): boolean {
  const line = s.screen().split("\n").find((l) => label.test(l.replace(/^[\s❯]*\d+\.\s*/, "")) && /^\s*❯?\s*\d+\./.test(l));
  const n = line?.match(/(\d+)\./)?.[1];
  if (!n) return false;
  s.key(n);
  return true;
}
const terminalYes = (s: Seat) => choose(s, /^Yes\b(?!,)/);
const terminalNo = (s: Seat) => choose(s, /^No\b/);
const idle = (s: Seat, ms = 90_000) => until(() => s.presence()?.status === "idle" && READY.some((r) => s.screen().includes(r)), ms, 200);
const hookAlive = (h: HookRun | undefined) => h !== undefined && h.ended === undefined;

// ---- case helpers ----------------------------------------------------------------------------------

/** A rule for one seat's hook events: the next `times` events that match get `action`. */
function rule(s: Seat, match: (ev: HookEvent) => boolean, action: Action, times = 1): Rule {
  const r: Rule = { actor: s.actor, match, action, left: times, hits: [], gates: [] };
  rules.push(r);
  return r;
}
const named = (...names: string[]) => (ev: HookEvent) => names.includes(String(ev.hook_event_name));
const hooksOf = (s: Seat, name: string) => runs.filter((r) => r.actor === s.actor && r.event.hook_event_name === name);
const openIds = async (s: Seat) => new Set((await list(s)).open.map((x) => x.id));
/** Ask Claude for one Bash call and wait for the prompt it opens, with Claude's dialog on screen. */
async function ask(s: Seat, text: string): Promise<Opened> {
  const before = await openIds(s);
  await s.say(text);
  const o = await waitOpen(s, before);
  await s.waitScreen(DIALOG, 15_000);
  return o;
}
/** A Bash call whose input the model cannot vary: identity cases compare inputs across calls. */
const exact = (command: string) => `Call the Bash tool once with exactly this input and nothing else: command "${command}", description "mark". Then reply with the single word done.`;
const subjectInput = (o: Opened) => (o.full.content.subject as { input: { kind: string; value?: unknown; bytes?: number } }).input;
const printed = (h: HookRun | undefined) => {
  try { return h?.ended?.out ? (JSON.parse(h.ended.out) as { hookSpecificOutput?: { decision?: { behavior?: string; message?: string } } }) : undefined; } catch { return undefined; }
};
const decisionOf = (h: HookRun | undefined) => printed(h)?.hookSpecificOutput?.decision;
/** Each card the run showed for `id`, so a case can say what no card claims. */
const cardsOf = (id: string) => (timelines.get(id)?.states ?? []).join(" ");
const NO_FALSE_CLAIM = /did not run|ran after|too late|late|stopped waiting/i;

type Case = { name: string; run: (name: string) => Promise<void> };
const cases: Case[] = [
  {
    name: "remote-allow",
    run: async (name) => {
      const s = await launch(name);
      const f = target("allow");
      const { p, full, hook } = await ask(s, touch(f));
      const subject = full.content.subject as { type: string; name: string; input: { kind: string; value?: { command?: string } }; cwd?: string };
      check(`${name}: the permission opens a prompt: Allow Bash?, the command shown, its cwd, allow and deny, harness claude-code, no scope`,
        full.content.title === "Allow Bash?" && subject.input.kind === "shown" && subject.input.value?.command === `touch ${f}` && subject.cwd === work &&
          full.content.options.map((x) => x.id).join() === "allow,deny" && canon(full.content.source) === canon({ harness: "claude-code" }),
        full.content);
      check(`${name}: Claude's own dialog is on screen while the prompt is open`, DIALOG.test(s.screen()), s.screen());
      check(`${name}: presence counts the prompt as open, and shows the session waiting for approval`,
        (await until(() => { const x = s.presence(); return x?.prompts?.open === 1 && x.status === "waiting" && x.condition?.code === "approval"; }, 10_000)) === true,
        s.presence());
      s.snap("dialog open, prompt open");
      const scan = await scanBroker();
      check(`${name}: while the prompt is open no stream holds its id or its tool input (${scan.streams} streams, ${scan.messages} messages)`, scan.hits.length === 0, scan.hits);
      const r = await answer(s, p, "allow");
      check(`${name}: prompt-answer replies sent, delivered`, isSent(replyState(r), "allow", "delivered"), r);
      check(`${name}: Claude runs the command`, (await until(() => existsSync(f), 30_000)) === true);
      await hook?.done;
      check(`${name}: the hook printed the allow decision and exited 0`, hook?.ended?.code === 0 && decisionOf(hook)?.behavior === "allow", hook?.ended);
      check(`${name}: the batch closes it unconfirmed with a subject-tied proceed`, closedAs(await waitState(s, p.id, (x) => x.kind === "closed"), "unconfirmed", "subject", "allow"));
      await idle(s);
      s.snap("after");
      check(`${name}: Claude says the hook allowed it`, /Allowed by PermissionRequest hook/.test(s.screen()), s.screen());
      check(`${name}: presence counts no prompt once it closed`, s.presence()?.prompts?.open === 0, s.presence()?.prompts);
    },
  },
  {
    name: "remote-deny",
    run: async (name) => {
      const s = await launch(name);
      const f = target("deny");
      const { p, hook } = await ask(s, touch(f));
      const r = await answer(s, p, "deny", "not this one");
      check(`${name}: prompt-answer replies sent, delivered`, isSent(replyState(r), "deny", "delivered"), r);
      await hook?.done;
      check(`${name}: the hook printed the deny decision with the note as its message`, decisionOf(hook)?.behavior === "deny" && decisionOf(hook)?.message === "not this one", hook?.ended);
      await idle(s);
      s.snap("after");
      check(`${name}: Claude did not run the command`, !existsSync(f));
      const batches = hooksOf(s, "PostToolBatch");
      log(name, `PostToolBatch for the denied call: ${batches.length ? batches.map((b) => JSON.stringify(b.event.tool_calls)).join(" | ") : "none fired"}`);
      const st = await waitState(s, p.id, (x) => x.kind === "closed", 30_000);
      check(`${name}: the turn end closes it unconfirmed with nothing seen (Deny submitted. No result was observed.)`, closedAs(st, "unconfirmed", "none", "deny"), show(st));
      await idle(s);
      const g = target("deny-bare");
      const o = await ask(s, touch(g));
      await answer(s, o.p, "deny");
      await o.hook?.done;
      check(`${name}: a deny with no note prints a deny whose message is Permission denied.`, decisionOf(o.hook)?.behavior === "deny" && decisionOf(o.hook)?.message === "Permission denied.", o.hook?.ended);
      await idle(s);
      check(`${name}: Claude did not run the second command`, !existsSync(g));
      const bare = hooksOf(s, "PostToolBatch").slice(batches.length);
      log(name, `PostToolBatch for the call denied with no note: ${bare.length ? bare.map((b) => JSON.stringify(b.event.tool_calls)).join(" | ") : "none fired"}`);
      const st2 = await waitState(s, o.p.id, (x) => x.kind === "closed", 30_000);
      check(`${name}: with no note too, the turn end closes it unconfirmed with nothing seen`, closedAs(st2, "unconfirmed", "none", "deny"), show(st2));
    },
  },
  ...(["allow", "deny"] as const).map((option): Case => ({
    name: `terminal-yes-late-${option}`,
    run: async (name) => {
      const s = await launch(name);
      const f = target(`late-${option}`);
      const { p, hook } = await ask(s, touch(f).replace(`touch ${f}`, `sleep 12 && touch ${f}`));
      check(`${name}: terminal Yes is pressed`, terminalYes(s), s.screen());
      await wait(1500);
      const st = await stateOf(s, p.id);
      check(`${name}: after terminal Yes the prompt is still open and its hook still runs`, isOpen(st) && hookAlive(hook), { st: show(st), hook: hook?.ended });
      const r = await answer(s, p, option, option === "deny" ? "stop" : undefined);
      check(`${name}: a late remote ${option} is accepted: sent, delivered`, isSent(replyState(r), option, "delivered"), r);
      check(`${name}: the command ran, as the terminal said`, (await until(() => existsSync(f), 30_000)) === true);
      const end = await waitState(s, p.id, (x) => x.kind === "closed", 30_000);
      check(`${name}: the batch closes it unconfirmed with a subject-tied proceed`, closedAs(end, "unconfirmed", "subject", option), show(end));
      check(`${name}: no card says the answer was late or that the call did not run`, !NO_FALSE_CLAIM.test(card(end!) ?? ""), card(end!));
      await idle(s);
    },
  })),
  {
    name: "terminal-yes-open",
    run: async (name) => {
      const s = await launch(name);
      const f = target("yes");
      const { p, hook } = await ask(s, touch(f));
      check(`${name}: terminal Yes is pressed`, terminalYes(s), s.screen());
      check(`${name}: the command runs`, (await until(() => existsSync(f), 30_000)) === true);
      const st = await waitState(s, p.id, (x) => x.kind === "closed", 30_000);
      check(`${name}: the batch closes the open prompt withdrawn with a subject-tied proceed`, closedAs(st, "withdrawn", "subject"), show(st));
      await until(() => hook?.ended, 10_000);
      check(`${name}: its hook is given {} and exits`, hook?.ended?.code === 0 && hook.ended.out === "{}", hook?.ended);
      await idle(s);
    },
  },
  {
    name: "terminal-no",
    run: async (name) => {
      const s = await launch(name);
      const f = target("no");
      const { p, hook } = await ask(s, touch(f));
      check(`${name}: terminal No is pressed`, terminalNo(s), s.screen());
      const st = await waitState(s, p.id, (x) => x.kind === "closed", 30_000);
      check(`${name}: the prompt closes withdrawn with nothing seen`, closedAs(st, "withdrawn", "none"), show(st));
      await until(() => hook?.ended, 10_000);
      log(name, `the hook after terminal No: ${hook?.ended?.code === undefined ? "killed by a signal" : `exit ${hook.ended.code}`}, printed ${hook?.ended?.out || "nothing"}`);
      await wait(3000);
      s.snap("after terminal No");
      check(`${name}: the command did not run`, !existsSync(f));
    },
  },
  {
    name: "interrupted-turn",
    run: async (name) => {
      const s = await launch(name);
      const f = target("esc");
      const { p, hook } = await ask(s, touch(f));
      s.key(KEY.esc);
      const st = await waitState(s, p.id, (x) => x.kind === "closed", 30_000);
      await until(() => hook?.ended, 10_000);
      s.snap("after Esc on the dialog");
      log(name, `Esc on an open prompt's dialog: ${show(st)}; the hook ${hook?.ended?.code === undefined ? "was killed" : `exited ${hook.ended.code}`}`);
      check(`${name}: Esc on the dialog closes the open prompt withdrawn with nothing seen`, closedAs(st, "withdrawn", "none"), show(st));
      check(`${name}: the command did not run`, !existsSync(f));
      await idle(s, 30_000);
      // An interrupt while the allowed command runs.
      const g = target("esc-running");
      const o = await ask(s, touch(g).replace(`touch ${g}`, `sleep 15 && touch ${g}`));
      const r = await answer(s, o.p, "allow");
      check(`${name}: a remote allow while the turn runs: sent, delivered`, isSent(replyState(r), "allow", "delivered"), r);
      await wait(2000);
      s.key(KEY.esc);
      await wait(4000);
      s.snap("after Esc on the running command");
      const mid = await stateOf(s, o.p.id);
      log(name, `after the interrupt the answered prompt is ${show(mid)}; events since: ${runs.filter((x) => x.actor === s.actor && x.seq > (o.hook?.seq ?? 0)).map((x) => x.event.hook_event_name).join(", ")}`);
      await idle(s, 30_000);
      await s.say("Reply with the single word ok.");
      const end = await waitState(s, o.p.id, (x) => x.kind === "closed", 60_000);
      check(`${name}: an interrupted answered prompt closes unconfirmed by the next turn end at the latest`, closedAs(end, "unconfirmed", undefined, "allow"), show(end));
      check(`${name}: the interrupted command did not finish`, !existsSync(g));
      await idle(s);
    },
  },
  {
    name: "hook-killed",
    run: async (name) => {
      const s = await launch(name);
      const f = target("killed");
      const { p, hook } = await ask(s, touch(f));
      process.kill(hook!.pid, "SIGKILL");
      const st = await waitState(s, p.id, (x) => x.kind === "closed", 15_000);
      check(`${name}: a hook killed from outside closes its open prompt withdrawn with nothing seen`, closedAs(st, "withdrawn", "none"), show(st));
      await wait(1000);
      check(`${name}: Claude's dialog is still on screen`, DIALOG.test(s.screen()), s.screen());
      check(`${name}: terminal Yes is pressed`, terminalYes(s));
      check(`${name}: the terminal dialog still answers: the command runs`, (await until(() => existsSync(f), 30_000)) === true);
      await idle(s);
      check(`${name}: the batch that follows changes nothing`, closedAs(await stateOf(s, p.id), "withdrawn", "none"));
    },
  },
  {
    name: "answer-race",
    run: async (name) => {
      const outcomes: string[] = [];
      // A fresh session each round: after a few refused calls Claude stops trying.
      for (const order of ["answer, then kill at once", "kill, then answer at once", "kill, then answer at once", "kill, then answer 300 ms later"]) {
        const s = await launch(name);
        const f = target("race");
        const { p, hook } = await ask(s, touch(f));
        let reply: Promise<EndpointReply>;
        if (order.startsWith("kill")) {
          process.kill(hook!.pid, "SIGKILL");
          if (order.endsWith("later")) await wait(300);
          reply = answer(s, p, "allow");
        } else {
          reply = answer(s, p, "allow");
          process.kill(hook!.pid, "SIGKILL");
        }
        const r = await reply;
        const st = await waitState(s, p.id, (x) => x.kind === "closed", 3_000);
        await hook!.done;
        outcomes.push(`${order}: reply ${r.ok ? show(replyState(r)) : `${r.error.code}/${r.error.outcome}`}, then ${show(st)}; hook printed ${hook!.ended?.out || "nothing"}`);
        log(name, outcomes.at(-1)!);
        check(`${name} (${order}): the prompt ends in one of the two orders the module allows: answer first, sent and unconfirmed; close first, withdrawn and the answer refused`,
          (r.ok && isSent(st, "allow", "unconfirmed")) || (!r.ok && closedAs(st, "withdrawn", "none")), { reply: r.ok ? show(replyState(r)) : r.error, st: show(st) });
        await wait(1000);
        if (DIALOG.test(s.screen())) terminalNo(s);
        await idle(s, 30_000);
        await s.close();
      }
      log(name, `outcomes: ${outcomes.join(" || ")}`);
    },
  },
  {
    name: "die-before-receipt",
    run: async (name) => {
      const s = await launch(name);
      const f = target("receipt");
      const r1 = rule(s, named("PermissionRequest"), "die-after-write");
      // The batch and the turn end are held back, so the state between the death and the evidence shows.
      const batch = rule(s, named("PostToolBatch"), "defer");
      const stop = rule(s, named("Stop"), "defer");
      const { p, hook } = await ask(s, touch(f));
      const r = await answer(s, p, "allow");
      await hook?.done;
      check(`${name}: the hook printed the allow and died before its receipt`, hook?.ended?.code === undefined && decisionOf(hook)?.behavior === "allow", hook?.ended);
      check(`${name}: prompt-answer replies sent, unconfirmed`, isSent(replyState(r), "allow", "unconfirmed"), r);
      await wait(3000);
      const mid = await stateOf(s, p.id);
      s.snap("after the hook died");
      const ran = existsSync(f);
      log(name, `Claude ${ran ? "applied" : "did not apply"} the output of a hook killed after it printed`);
      check(`${name}: with no receipt and no later evidence it stays sent, unconfirmed`, isSent(mid, "allow", "unconfirmed"), show(mid));
      for (const g of [...batch.gates, ...stop.gates]) await g.release();
      batch.left = stop.left = 0;
      check(`${name}: nothing is written again: one hook process for the permission, one line printed`,
        hooksOf(s, "PermissionRequest").length === 1 && r1.hits.length === 1 && (hook?.ended?.out.split("\n").length ?? 0) === 1, hooksOf(s, "PermissionRequest").map((h) => h.ended));
      if (!ran && DIALOG.test(s.screen())) terminalNo(s);
      const end = await waitState(s, p.id, (x) => x.kind === "closed", 60_000);
      check(`${name}: it closes unconfirmed once a batch or the turn end arrives`, closedAs(end, "unconfirmed", undefined, "allow"), show(end));
      await idle(s);
    },
  },
  {
    name: "question-left-to-terminal",
    run: async (name) => {
      const s = await launch(name);
      await s.say("Use the AskUserQuestion tool to ask me one question: which color do I prefer, with the two options Red and Blue. Then reply with the color I chose.");
      const hook = await until(() => hooksOf(s, "PermissionRequest").find((h) => h.event.tool_name === "AskUserQuestion"), 60_000);
      await until(() => hook?.ended, 10_000);
      s.snap("question");
      log(name, `AskUserQuestion: ${hook ? `PermissionRequest fired, the hook printed ${hook.ended?.out || "nothing"}` : "no PermissionRequest fired"}`);
      check(`${name}: the question's permission gets {} at once and opens no prompt`, hook !== undefined && hook.ended?.out === "{}" && (await list(s)).open.length === 0 && (await list(s)).closed.length === 0, hook?.ended);
      check(`${name}: the question is on screen for the terminal`, await s.waitScreen(/Red/, 10_000), s.screen());
      s.key("1");
      await wait(500);
      if (/Submit answers|Review your answers/.test(s.screen())) s.key(KEY.enter);
      await idle(s);
      s.snap("after");
    },
  },
  {
    name: "plan-left-to-terminal",
    run: async (name) => {
      const s = await launch(name, { launchOptions: { "permission-mode": "plan" } });
      const f = target("plan");
      await s.say(`Plan how to create the empty file ${f}. The plan is one line: run touch ${f}. Present it now with the ExitPlanMode tool.`);
      const hook = await until(() => hooksOf(s, "PermissionRequest").find((h) => h.event.tool_name === "ExitPlanMode"), 90_000);
      await until(() => hook?.ended, 10_000);
      s.snap("plan");
      log(name, `ExitPlanMode: ${hook ? `PermissionRequest fired, the hook printed ${hook.ended?.out || "nothing"}` : "no PermissionRequest fired"}`);
      check(`${name}: the plan's permission gets {} at once and opens no prompt`, hook !== undefined && hook.ended?.out === "{}" && (await list(s)).open.length === 0 && (await list(s)).closed.length === 0, hook?.ended);
      check(`${name}: the plan approval is on screen for the terminal`, await s.waitScreen(/proceed|approve|keep planning/i, 10_000), s.screen());
      s.key(KEY.esc);
      await idle(s, 30_000);
      check(`${name}: the plan did not run`, !existsSync(f));
    },
  },
  {
    name: "over-limit",
    run: async (name) => {
      const s = await launch(name);
      const f = target("big");
      // Claude cannot cheaply write a 256 KiB tool input, so the shim pads the input it reports.
      rule(s, named("PermissionRequest"), { rewrite: (ev) => ({ ...ev, tool_input: { ...(ev.tool_input as object), padding: "x".repeat(270_000) } }) });
      const o = await ask(s, touch(f));
      const input = subjectInput(o);
      check(`${name}: the input is shown as omitted, with its size`, input.kind === "omitted" && (input.bytes ?? 0) > 262_144 && input.value === undefined, { kind: input.kind, bytes: input.bytes });
      check(`${name}: only deny is offered`, o.full.content.options.map((x) => x.id).join() === "deny", o.full.content.options);
      const refused = await answer(s, o.p, "allow");
      check(`${name}: an allow is refused bad-request and the prompt stays open`, !refused.ok && refused.error.code === "bad-request" && isOpen(await stateOf(s, o.p.id)), refused);
      const r = await answer(s, o.p, "deny", "too big to read");
      check(`${name}: a deny is accepted: sent, delivered`, isSent(replyState(r), "deny", "delivered"), r);
      await o.hook?.done;
      check(`${name}: the hook printed the deny`, decisionOf(o.hook)?.behavior === "deny", o.hook?.ended);
      await idle(s);
      check(`${name}: Claude did not run the command`, !existsSync(f));
    },
  },
  {
    name: "lost-batch-then-turn-end",
    run: async (name) => {
      const s = await launch(name);
      const f = target("lost-batch");
      const dropped = rule(s, named("PostToolBatch"), "drop", Infinity);
      const { p } = await ask(s, touch(f));
      await answer(s, p, "allow");
      check(`${name}: the command runs`, (await until(() => existsSync(f), 30_000)) === true);
      const st = await waitState(s, p.id, (x) => x.kind === "closed", 60_000);
      check(`${name}: with its batch lost, the turn end closes it unconfirmed with nothing seen`, dropped.hits.length >= 1 && closedAs(st, "unconfirmed", "none", "allow"), { dropped: dropped.hits.length, st: show(st) });
      await idle(s);
    },
  },
  {
    name: "lost-turn-end-then-next",
    run: async (name) => {
      const s = await launch(name);
      const f = target("lost-stop");
      const batch = rule(s, named("PostToolBatch"), "drop");
      const stop = rule(s, named("Stop"), "drop");
      const { p } = await ask(s, touch(f));
      await answer(s, p, "allow");
      check(`${name}: the command runs`, (await until(() => existsSync(f), 30_000)) === true);
      await until(() => stop.hits.length > 0, 60_000);
      await wait(3000);
      const mid = await stateOf(s, p.id);
      check(`${name}: with its batch and turn end lost, the prompt stays sent, delivered after the turn`, batch.hits.length === 1 && stop.hits.length === 1 && isSent(mid, "allow", "delivered"), show(mid));
      await s.say("Reply with the single word ok.");
      const st = await waitState(s, p.id, (x) => x.kind === "closed", 60_000);
      check(`${name}: the next turn end closes it unconfirmed with nothing seen`, closedAs(st, "unconfirmed", "none", "allow"), show(st));
      await idle(s);
    },
  },
  {
    name: "expired",
    run: async (name) => {
      const pidFile = join(shimDir, "clock.pid");
      const preload = join(shimDir, "clock.cjs");
      writeFileSync(preload, `"use strict";
// Test-only clock for the seat process: long timers run every second, and SIGUSR2 moves Date.now
// eight days ahead for three seconds, past a 7-day expiresAt.
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const realNow = Date.now.bind(Date), realSetTimeout = global.setTimeout, DAY = 86400000;
let offset = 0;
Date.now = () => realNow() + offset;
global.setTimeout = function (fn, ms, ...a) { return realSetTimeout(fn, typeof ms === "number" && ms >= DAY ? 1000 : ms, ...a); };
process.on("SIGUSR2", () => { offset = 8 * DAY; realSetTimeout(() => { offset = 0; }, 3000); });
`);
      const seatArgs = ["--require", preload, ...SEAT_ARGS];
      const s = await launch(name, { plugin: pluginCopy("clocked", seatArgs), seatArgs });
      const f = target("expired");
      const { p, hook } = await ask(s, touch(f));
      const dropped = rule(s, (ev) => ev.hook_event_name !== "PermissionRequest", "drop", Infinity);
      check(`${name}: the prompt is offered for 7 days`, Date.parse(p.expiresAt) - Date.parse(p.openedAt) === 7 * 86_400_000, p);
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGUSR2");
      const st = await waitState(s, p.id, (x) => x.kind === "closed", 20_000);
      check(`${name}: past expiresAt the open prompt closes expired`, closedAs(st, "expired"), show(st));
      await until(() => hook?.ended, 10_000);
      check(`${name}: its hook is given {} and exits`, hook?.ended?.code === 0 && hook.ended.out === "{}", hook?.ended);
      check(`${name}: Claude's dialog still answers`, DIALOG.test(s.screen()) && terminalNo(s), s.screen());
      await wait(3000);
      dropped.left = 0;
      log(name, `events dropped while the prompt was open: ${dropped.hits.map((h) => h.event.hook_event_name).join(", ") || "none"}`);
    },
  },
  {
    name: "consumer",
    run: async (name) => {
      // With no prompt: a turn whose Stop the shim turns into a StopFailure with error rate_limit.
      const s = await launch(name);
      const statuses: string[] = [];
      const watch = setInterval(() => {
        const x = s.presence();
        const label = `${x?.status}${x?.condition ? `/${x.condition.code}` : ""}${x?.prompts ? ` prompts=${x.prompts.open}` : ""}`;
        if (statuses.at(-1) !== label) statuses.push(label);
      }, 50);
      try {
        rule(s, named("Stop"), { rewrite: (ev) => ({ ...ev, hook_event_name: "StopFailure", error: "rate_limit", error_details: "429 (injected by the suite)" }) });
        await s.say("Reply with the single word ok.");
        const failure = await until(() => s.presence()?.condition?.code === "rate_limit" ? s.presence() : undefined, 60_000);
        check(`${name}: with no prompt, a StopFailure with error rate_limit sets that condition`, failure?.condition?.source === "rate_limit", s.presence());
        const mine = runs.filter((r) => r.actor === s.actor);
        await Promise.all(mine.map((r) => r.done));
        check(`${name}: with no prompt, every hook event got one reply from the connector, a JSON object, exit 0`,
          mine.length >= 3 && mine.every((r) => r.ended?.code === 0 && (r.event.hook_event_name === "SessionEnd" || /^\{/.test(r.ended.out))), mine.map((r) => [r.event.hook_event_name, r.ended]));
        check(`${name}: SessionStart got the orientation card whole`, /You are pp\d+ in space/.test(hooksOf(s, "SessionStart")[0]?.ended?.out ?? ""));
        // With a prompt open: the Notification still reaches the consumer, and a StopFailure relayed
        // through the shipped hook sets the condition and ends the main thread's turn.
        const f = target("consumer");
        const { p, hook } = await ask(s, touch(f));
        check(`${name}: with a prompt open, the Notification reaches the consumer: waiting, condition approval`,
          (await until(() => s.presence()?.status === "waiting" && s.presence()?.condition?.code === "approval", 10_000)) === true, s.presence());
        const failed: HookEvent = {
          session_id: hook!.event.session_id, transcript_path: hook!.event.transcript_path, cwd: hook!.event.cwd,
          hook_event_name: "StopFailure", error: "rate_limit", error_details: "429 (injected by the suite)",
        };
        await replay({ ...hook!, event: failed, raw: JSON.stringify(failed) });
        check(`${name}: with a prompt open, a StopFailure with error rate_limit sets that condition`,
          (await until(() => s.presence()?.condition?.code === "rate_limit", 10_000)) === true, s.presence());
        const st = await waitState(s, p.id, (x) => x.kind === "closed", 10_000);
        check(`${name}: ... and, as a turn end, withdraws the open prompt with nothing seen`, closedAs(st, "withdrawn", "none"), show(st));
        await until(() => hook?.ended, 10_000);
        check(`${name}: ... its hook given {}`, hook?.ended?.out === "{}", hook?.ended);
        if (DIALOG.test(s.screen())) terminalNo(s);
        await wait(3000);
        log(name, `presence seen by alice's session: ${statuses.join(" -> ")}`);
      } finally {
        clearInterval(watch);
      }
    },
  },
  // ---- the identity cases ----------------------------------------------------------------------------
  {
    name: "identity-delayed-batch",
    run: async (name) => {
      const s = await launch(name);
      const f = target("delayed");
      const batch = rule(s, named("PostToolBatch"), "defer");
      const { p } = await ask(s, touch(f).replace(`touch ${f}`, `sleep 8 && touch ${f}`));
      check(`${name}: terminal Yes is pressed`, terminalYes(s));
      await wait(1000);
      const r = await answer(s, p, "deny", "no");
      check(`${name}: a remote deny is sent, delivered`, isSent(replyState(r), "deny", "delivered"), r);
      const st = await waitState(s, p.id, (x) => x.kind === "closed", 60_000);
      check(`${name}: the turn end, delivered before the batch, closes it unconfirmed with nothing seen`, batch.gates.length === 1 && closedAs(st, "unconfirmed", "none", "deny"), show(st));
      await batch.gates[0]!.release();
      await wait(1500);
      const after = await stateOf(s, p.id);
      check(`${name}: the late batch matches no live prompt and changes nothing`, show(after) === show(st), show(after));
      check(`${name}: the command ran, and no card shown says it did not`, existsSync(f) && !NO_FALSE_CLAIM.test(`${card(st!)} ${card(after!)}`), cardsOf(p.id));
      await idle(s);
    },
  },
  {
    name: "identity-twin",
    run: async (name) => {
      const s = await launch(name);
      const f = target("twin");
      const batch = rule(s, named("PostToolBatch"), "defer");
      const p1 = await ask(s, exact(`touch ${f}`));
      process.kill(p1.hook!.pid, "SIGKILL");
      check(`${name}: P1's hook is killed and P1 closes withdrawn, nothing seen`, closedAs(await waitState(s, p1.p.id, (x) => x.kind === "closed", 15_000), "withdrawn", "none"));
      await wait(1000);
      check(`${name}: P1's terminal dialog allows the call`, terminalYes(s) && (await until(() => existsSync(f), 30_000)) === true);
      await until(() => batch.gates.length === 1, 30_000);
      await idle(s);
      const p2 = await ask(s, exact(`touch ${f}`));
      const same = canon(subjectInput(p2).value) === canon(subjectInput(p1).value);
      check(`${name}: P2 has P1's scope, name and input`, same, [subjectInput(p1).value, subjectInput(p2).value]);
      await batch.gates[0]!.release();
      const st2 = await waitState(s, p2.p.id, (x) => x.kind === "closed", 15_000);
      check(`${name}: P1's batch arrives while P2 waits: P2 closes withdrawn with a subject-tied proceed`, closedAs(st2, "withdrawn", "subject"), show(st2));
      check(`${name}: no card says P2 ran`, !/ran\b/.test(card(st2!) ?? ""), card(st2!));
      await until(() => p2.hook?.ended, 10_000);
      check(`${name}: P2's hook is given {}, and its terminal dialog still answers`, p2.hook?.ended?.out === "{}" && DIALOG.test(s.screen()), { hook: p2.hook?.ended, screen: s.screen() });
      check(`${name}: P1 stays withdrawn, nothing seen`, closedAs(await stateOf(s, p1.p.id), "withdrawn", "none"));
      terminalYes(s);
      await idle(s);
    },
  },
  {
    name: "identity-previous-turn",
    run: async (name) => {
      const s = await launch(name);
      const f = target("prev");
      const batch = rule(s, named("PostToolBatch"), "defer");
      const p1 = await ask(s, exact(`touch ${f}`));
      await answer(s, p1.p, "allow");
      check(`${name}: turn 1's call runs`, (await until(() => existsSync(f), 30_000)) === true);
      const st1 = await waitState(s, p1.p.id, (x) => x.kind === "closed", 60_000);
      check(`${name}: turn 1's prompt closes at its turn end, its batch held back`, closedAs(st1, "unconfirmed", "none", "allow") && batch.gates.length === 1, show(st1));
      await idle(s);
      const p2 = await ask(s, exact(`touch ${f}`));
      check(`${name}: the new prompt has the same key`, canon(subjectInput(p2).value) === canon(subjectInput(p1).value), [subjectInput(p1).value, subjectInput(p2).value]);
      await batch.gates[0]!.release();
      const st2 = await waitState(s, p2.p.id, (x) => x.kind === "closed", 15_000);
      check(`${name}: the previous turn's batch closes the new identical prompt withdrawn with a subject-tied proceed`, closedAs(st2, "withdrawn", "subject"), show(st2));
      await until(() => p2.hook?.ended, 10_000);
      check(`${name}: its hook is given {} and its terminal dialog still answers`, p2.hook?.ended?.out === "{}" && DIALOG.test(s.screen()) && terminalYes(s));
      await idle(s);
    },
  },
  {
    name: "identity-no-entry",
    run: async (name) => {
      const s = await launch(name);
      const f = target("other"), g = target("waiting");
      const batch = rule(s, named("PostToolBatch"), "defer");
      const p1 = await ask(s, exact(`touch ${f}`));
      await answer(s, p1.p, "allow");
      await until(() => batch.gates.length === 1, 60_000);
      await idle(s);
      const p2 = await ask(s, exact(`touch ${g}`));
      await batch.gates[0]!.release();
      await wait(2000);
      check(`${name}: a batch with no entry for a waiting prompt's key changes nothing`, isOpen(await stateOf(s, p2.p.id)) && hookAlive(p2.hook));
      await answer(s, p2.p, "allow");
      await idle(s);
    },
  },
  {
    name: "identity-rule-allowed",
    run: async (name) => {
      // A project rule allows the call in turn 1, so it runs with no prompt. The rule is then removed
      // and turn 2's identical call asks. Turn 1's batch is held back until turn 2's prompt waits.
      const f = target("rule");
      const settings = join(work, ".claude", "settings.local.json");
      mkdirSync(join(work, ".claude"), { recursive: true });
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [`Bash(touch ${f})`] } }));
      try {
        const s = await launch(name);
        const batch = rule(s, named("PostToolBatch"), "defer");
        await s.say(exact(`touch ${f}`));
        check(`${name}: turn 1's call runs under the rule with no permission asked`, (await until(() => existsSync(f), 60_000)) === true && hooksOf(s, "PermissionRequest").length === 0);
        await until(() => batch.gates.length === 1, 30_000);
        await idle(s);
        writeFileSync(settings, JSON.stringify({ permissions: { allow: [] } }));
        await wait(3000);
        const p = await ask(s, exact(`touch ${f}`));
        check(`${name}: with the rule gone, the identical call asks: a prompt with the key the rule-allowed call had`,
          canon(subjectInput(p).value) === canon(batch.gates[0]!.run.event.tool_calls && (batch.gates[0]!.run.event.tool_calls as { tool_input: unknown }[])[0]!.tool_input));
        await batch.gates[0]!.release();
        const st = await waitState(s, p.p.id, (x) => x.kind === "closed", 15_000);
        check(`${name}: the rule-allowed call's batch closes the waiting prompt withdrawn with a subject-tied proceed`, closedAs(st, "withdrawn", "subject"), show(st));
        await until(() => p.hook?.ended, 10_000);
        check(`${name}: its hook is given {} and its terminal dialog still answers`, p.hook?.ended?.out === "{}" && DIALOG.test(s.screen()) && terminalYes(s));
        await idle(s);
      } finally {
        rmSync(join(work, ".claude"), { recursive: true, force: true });
      }
    },
  },
  {
    name: "identity-counts",
    run: async (name) => {
      const s = await launch(name);
      const f = target("count");
      const b1 = rule(s, named("PostToolBatch"), "defer");
      const p0 = await ask(s, exact(`touch ${f}`));
      await answer(s, p0.p, "allow");
      await until(() => b1.gates.length === 1, 60_000);
      await idle(s);
      check(`${name}: turn 1's batch, held back, lists one entry`, (b1.gates[0]!.run.event.tool_calls as unknown[]).length === 1);
      // Turn 2: two identical calls in one message. Claude asks for them one after the other.
      const b2 = rule(s, named("PostToolBatch"), "defer");
      const before = await openIds(s);
      await s.say(`In one single message, call the Bash tool twice in parallel, both times with exactly this input: command "touch ${f}", description "mark". Then reply with the single word done.`);
      const pa = await waitOpen(s, before);
      await answer(s, pa.p, "allow");
      const pb = await waitOpen(s, new Set([...before, pa.p.id]), 60_000);
      const sameKey = canon(subjectInput(pa).value) === canon(subjectInput(pb).value) && canon(subjectInput(pa).value) === canon(subjectInput(p0).value);
      const [sa, sb] = [await stateOf(s, pa.p.id), await stateOf(s, pb.p.id)];
      check(`${name}: two live prompts with one key, one sent and one open`, sameKey && isSent(sa, "allow") && isOpen(sb), { sameKey, sa: show(sa), sb: show(sb) });
      await b1.gates[0]!.release();
      const [ea, eb] = [await waitState(s, pa.p.id, (x) => x.kind === "closed", 15_000), await waitState(s, pb.p.id, (x) => x.kind === "closed", 15_000)];
      check(`${name}: fewer entries than prompts: one entry, and each live prompt with the key gets the same subject-tied report`,
        closedAs(ea, "unconfirmed", "subject", "allow") && closedAs(eb, "withdrawn", "subject"), [show(ea), show(eb)]);
      await wait(1000);
      if (DIALOG.test(s.screen())) terminalYes(s);
      await until(() => b2.gates.length === 1, 60_000);
      await idle(s);
      const entries = (b2.gates[0]!.run.event.tool_calls as unknown[]).length;
      // Turn 3: one prompt, and the two-entry batch of turn 2.
      const pc = await ask(s, exact(`touch ${f}`));
      await b2.gates[0]!.release();
      const ec = await waitState(s, pc.p.id, (x) => x.kind === "closed", 15_000);
      check(`${name}: more entries than prompts: a batch with ${entries} entries and one live prompt closes it withdrawn with one subject-tied sighting`,
        entries === 2 && closedAs(ec, "withdrawn", "subject"), { entries, ec: show(ec) });
      await wait(1000);
      if (DIALOG.test(s.screen())) terminalYes(s);
      await idle(s);
    },
  },
  {
    name: "two-open",
    run: async (name) => {
      const s = await launch(name);
      const a = target("main"), b = target("sub");
      const before = await openIds(s);
      await s.say(`Do two things at once. First, use the Agent tool with run_in_background set to true to start a general-purpose subagent whose whole task is: call the Bash tool once with command "touch ${b}" and description "sub", then stop. Second, without waiting for it, call the Bash tool yourself once with command "touch ${a}" and description "main". Then reply with the single word done.`);
      const both = await until(async () => { const l = (await list(s)).open.filter((x) => !before.has(x.id)); return l.length === 2 ? l : undefined; }, 90_000, 250);
      check(`${name}: two prompts are open at once, one in the main thread and one in the subagent's scope`,
        both !== undefined && both.filter((x) => x.source?.scope === undefined).length === 1 && both.filter((x) => typeof x.source?.scope === "string").length === 1, both?.map((x) => x.source));
      if (!both) return;
      const main = both.find((x) => x.source?.scope === undefined)!, sub = both.find((x) => x.source?.scope !== undefined)!;
      for (const p of both) note(s, p.id, p.state);
      s.snap("two prompts open");
      const r1 = await answer(s, sub, "allow");
      check(`${name}: the subagent's prompt takes an allow while the main thread's stays open`, isSent(replyState(r1), "allow", "delivered") && isOpen(await stateOf(s, main.id)));
      check(`${name}: the subagent runs its call`, (await until(() => existsSync(b), 30_000)) === true);
      const r2 = await answer(s, main, "deny", "Denied. Do not retry it, reply with the single word done.");
      check(`${name}: the main thread's prompt takes a deny`, isSent(replyState(r2), "deny", "delivered"), r2);
      const [es, em] = [await waitState(s, sub.id, (x) => x.kind === "closed", 60_000), await waitState(s, main.id, (x) => x.kind === "closed", 60_000)];
      check(`${name}: each settles on its own: the subagent's allow unconfirmed with a subject-tied proceed`, closedAs(es, "unconfirmed", "subject", "allow"), show(es));
      check(`${name}: ... and the main thread's deny, whose refused call its batch lists, closes unconfirmed with nothing seen at its turn end`, closedAs(em, "unconfirmed", "none", "deny"), show(em));
      check(`${name}: the main thread's call did not run`, !existsSync(a));
      await idle(s);
    },
  },
  {
    name: "scopes",
    run: async (name) => {
      const s = await launch(name);
      const f = target("scope");
      const before = await openIds(s);
      await s.say(`Do two things at once. First, use the Agent tool with run_in_background set to true to start a general-purpose subagent whose whole task is: call the Bash tool once with command "touch ${f}" and description "mark", then stop. Second, without waiting for it, call the Bash tool yourself once with command "touch ${f}" and description "mark". Then reply with the single word done.`);
      const both = await until(async () => { const l = (await list(s)).open.filter((x) => !before.has(x.id)); return l.length === 2 ? l : undefined; }, 90_000, 250);
      if (!both) {
        check(`${name}: a main-thread call and a subagent call with the same name and input both ask`, false, (await list(s)).open);
        return;
      }
      const main = both.find((x) => x.source?.scope === undefined), sub = both.find((x) => x.source?.scope !== undefined);
      const inputs = await Promise.all(both.map(async (x) => canon((await read(s, x.id)).content.subject)));
      check(`${name}: a main-thread call and a subagent call with the same name and input both ask, in their own scopes`,
        main !== undefined && sub !== undefined && inputs[0] === inputs[1], { scopes: both.map((x) => x.source), inputs });
      if (!main || !sub) return;
      for (const p of both) note(s, p.id, p.state);
      await answer(s, sub, "allow");
      const es = await waitState(s, sub.id, (x) => x.kind === "closed", 60_000);
      check(`${name}: the subagent's batch settles only its own prompt: unconfirmed with a subject-tied proceed`, closedAs(es, "unconfirmed", "subject", "allow"), show(es));
      check(`${name}: ... and the main thread's identical prompt stays open`, isOpen(await stateOf(s, main.id)));
      await answer(s, main, "allow");
      const em = await waitState(s, main.id, (x) => x.kind === "closed", 60_000);
      check(`${name}: the main thread's batch settles the main thread's`, closedAs(em, "unconfirmed", "subject", "allow"), show(em));
      await idle(s);
    },
  },
];

// ---- run ---------------------------------------------------------------------------------------------

let brokerScan: { streams: number; messages: number; hits: string[] } | undefined;
try {
  for (const c of cases) {
    if (ONLY.size && !ONLY.has(c.name)) continue;
    console.log(`\n${c.name}`);
    try {
      await c.run(c.name);
    } catch (e) {
      check(`${c.name}: the case ran to its end`, false, (e as Error).stack);
    } finally {
      for (const s of [...open].filter((x) => x.name === c.name)) await s.close().catch(() => {});
    }
  }

  console.log("\nevery state seen is in the Claude adapter's card table");
  check("no prompt reached a state outside the card table (confirmed, local, answered, or a prompt-tied sighting)", offTable.length === 0, offTable);

  console.log("\nnothing about a prompt is stored on the broker");
  brokerScan = await scanBroker();
  check(`no stream holds a prompt id or a case's tool input (${brokerScan.streams} streams, ${brokerScan.messages} messages scanned)`, brokerScan.hits.length === 0, brokerScan.hits);
} finally {
  for (const s of [...open]) await s.close().catch(() => {});
  const leftovers = ownedProcesses();
  for (const pid of leftovers) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  if (leftovers.length) console.log(`killed ${leftovers.length} leftover process(es) this suite started: ${leftovers.join(", ")}`);
  await web.stop().catch(() => {});
  await calloutNc.close().catch(() => {});
  hub.close();
  await killAndAwaitExit(broker);
  releaseBroker();
  rmSync(brokerDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
if (LOG_DIR) {
  const summary = [...timelines.entries()].map(([id, t]) => `${t.seat.name} ${id.slice(0, 8)}: ${t.states.join(" -> ")}`);
  writeFileSync(join(LOG_DIR, "summary.txt"), `${summary.join("\n")}\n\npassed ${passed()}, failed ${failed()}\nbroker scan: ${JSON.stringify(brokerScan)}\n`);
}
console.log(`\nclaude-permission-prompts live: ${passed()} passed, ${failed()} failed`);
finish();

/** Every stream in the space's account, every message, searched for each prompt id and each case's
 *  tool input. The principal route has no stream: a prompt lives in the seat's process only. */
async function scanBroker(): Promise<{ streams: number; messages: number; hits: string[] }> {
  // A reader with no permission rows: every stream of the space's account, signed with its key.
  const natsJwt = createRequire(join(WT, "packages", "core", "package.json"))("@nats-io/jwt") as {
    encodeUser(name: string, user: unknown, account: unknown, perms: object, opts: { signer: unknown }): Promise<string>;
    fmtCreds(jwt: string, kp: unknown): Uint8Array;
    fromPublic(k: string): unknown;
    fromSeed(s: Uint8Array): unknown;
  };
  const enc = (x: string) => new TextEncoder().encode(x);
  const reader = newIdentity();
  const jwt = await natsJwt.encodeUser("prompts-scan", natsJwt.fromPublic(reader.id), natsJwt.fromPublic(auth.account.pub), {}, { signer: natsJwt.fromSeed(enc(auth.account.signingSeed)) });
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(natsJwt.fmtCreds(jwt, natsJwt.fromSeed(enc(reader.seed)))) });
  try {
    const jsm = await jetstreamManager(nc);
    const needles = [...timelines.keys(), ...targets];
    const hits: string[] = [];
    let streams = 0, messages = 0;
    const sample = epPrincipalRequestSubject(space, {
      endpoint: AGENT_ENDPOINT, principal: { owner: A, actor: "pp1", uid: WEB.uid, runtimeId: "r".repeat(36) }, command: "prompt-answer",
      authority: "owner", caller: { owner: A, actor: "web", uid: WEB.uid }, nonce: "n".repeat(32),
    });
    for await (const si of jsm.streams.list()) {
      streams++;
      for (const subj of si.config.subjects ?? []) if (subjectMatches(subj, sample)) hits.push(`stream ${si.config.name} captures the principal route (${subj})`);
      for (let seq = si.state.first_seq; seq > 0 && seq <= si.state.last_seq; seq++) {
        const m = await jsm.streams.getMessage(si.config.name, { seq }).catch(() => null);
        if (!m) continue;
        messages++;
        const text = new TextDecoder().decode(m.data);
        for (const n of needles) if (text.includes(n)) hits.push(`${si.config.name}#${seq} (${m.subject}) holds ${n.slice(0, 40)}`);
      }
    }
    return { streams, messages, hits };
  } finally {
    await nc.close();
  }
}
function subjectMatches(filter: string, subject: string): boolean {
  const f = filter.split("."), s = subject.split(".");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === ">") return s.length > i;
    if (i >= s.length || (f[i] !== "*" && f[i] !== s[i])) return false;
  }
  return f.length === s.length;
}
/** Processes this suite started that are still running: any whose environment names this suite's
 *  COTAL_HOME (Claude, its seat, its hooks), and the hook processes the suite relayed late. */
function ownedProcesses(): number[] {
  const mine: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid || Number(d) === broker.pid) continue;
    try {
      if (readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(`COTAL_HOME=${cotalHome}`)) mine.push(Number(d));
    } catch { /* gone or not ours */ }
  }
  return mine;
}
