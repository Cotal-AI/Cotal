/**
 * Claude Code's permission prompts, answered by the agent's owner from another session, on a real
 * broker with a real interactive Claude Code.
 *
 * The seat is the shipped launch (`buildLaunch` with `permission-mode=default`), its MCP server and
 * hook bundles, and `claude` itself in a tmux pane. The owner's browser actor `web` is an interactive
 * row: it watches the records and answers. Each case asks Claude to run one `touch`, so the file
 * says whether the command ran.
 *
 *  1. The owner approves after holding the prompt past the relay's 2 s deadline: the command runs,
 *     and the record says who approved. A sibling agent and a teammate are refused by the broker,
 *     and a second answer is refused naming the first.
 *  2. The owner denies with a note: nothing runs, and Claude reads the note as the reason.
 *  3. Yes at the terminal: the command runs and the record says the machine allowed it.
 *  4. No at the terminal: nothing runs and the record says the machine withdrew it.
 *  5. The agent dies holding a prompt: readers derive `gone`, and an answer reads `gone`.
 *
 * Needs nats-server, tmux, the `claude` CLI and a Claude login. The login file is copied from
 * COTAL_LIVE_CLAUDE_CREDENTIALS (default ~/.claude/.credentials.json) into a private 0700 config
 * directory and never printed. Without any of them the suite skips and says which.
 *
 * Run: pnpm smoke:claude-permission-requests:live   (build first: the seat runs the dist bundles)
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CotalEndpoint, DEV_OWNER, createSpaceAuth, holderLiveness, isReachable, mintCreds, mintLifecycleUid, newIdentity, principalId,
  provisionAgent, serverConfig, setupSpaceStreams, type PermissionRecord, type Presence,
} from "@cotal-ai/core";
import { claudeConnector } from "../src/extension.js";
import { createSuite, freePort, killAndAwaitExit, skipSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

const which = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim();
const CLAUDE = process.env.COTAL_LIVE_CLAUDE_BIN ?? which("claude");
const CREDENTIALS = process.env.COTAL_LIVE_CLAUDE_CREDENTIALS ?? join(homedir(), ".claude", ".credentials.json");
if (!which("tmux")) skipSuite("tmux is not on PATH");
if (!which("nats-server")) skipSuite("nats-server is not on PATH");
if (!CLAUDE) skipSuite("the claude CLI is not on PATH");
if (!existsSync(CREDENTIALS)) skipSuite("no Claude login file (set COTAL_LIVE_CLAUDE_CREDENTIALS)");

const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined | false, ms: number): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(250)) {
    const v = read();
    if (v) return v;
  }
  return undefined;
}

process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "cotal-perm-live-"));
const ws = join(root, "ws"), config = join(root, "claude"), home = join(root, "home");
// Claude writes its MCP server logs, which can quote a failing seat's credential, under the XDG
// directories it inherits, so every one of them stays inside this run.
const xdg = {
  XDG_CONFIG_HOME: join(root, "xdg", "config"), XDG_DATA_HOME: join(root, "xdg", "data"), XDG_STATE_HOME: join(root, "xdg", "state"),
  XDG_CACHE_HOME: join(root, "xdg", "cache"), XDG_RUNTIME_DIR: join(root, "xdg", "runtime"),
};
for (const d of [ws, config, home, ...Object.values(xdg)]) mkdirSync(d, { recursive: true });
copyFileSync(CREDENTIALS, join(config, ".credentials.json"));
writeFileSync(join(config, ".claude.json"), JSON.stringify({
  hasCompletedOnboarding: true, theme: "dark",
  projects: { [ws]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}));

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `perm-live-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(root, "js") }));
const srv = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, root);
const TMUX = ["-L", `cotal-perm-${randomUUID().slice(0, 8)}`];
const tmux = (...args: string[]) => spawnSync("tmux", [...TMUX, ...args], { encoding: "utf8" });
const screen = () => tmux("capture-pane", "-p", "-t", "seat").stdout ?? "";
const type = (text: string) => { tmux("send-keys", "-t", "seat", "-l", text); tmux("send-keys", "-t", "seat", "Enter"); };

const endpoints: CotalEndpoint[] = [];
try {
  for (let i = 0; i < 50 && !(await isReachable(SERVERS)); i++) await wait(200);
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionerCreds });
  async function endpoint(creds: string, card: { id?: string; name: string; owner?: string; actor?: string }, lifecycleUid: string, watchPresence = false) {
    const ep = new CotalEndpoint({ space, servers: SERVERS, creds, lifecycleUid, channels: [], consume: false, watchPresence, registerPresence: false, watchChannels: false, card: { kind: "agent", ...card } });
    ep.on("error", () => {});
    await ep.start();
    endpoints.push(ep);
    return ep;
  }
  const provisioner = await endpoint(provisionerCreds, { name: "provisioner" }, mintLifecycleUid());
  const seatId = newIdentity(), seatUid = mintLifecycleUid();
  const seatCreds = await provisionAgent(provisioner, auth, seatId, { lifecycleUid: seatUid, subscribe: [], allowSubscribe: [] });
  const AGENT = principalId(DEV_OWNER, seatId.id);
  async function principal(owner: string, actor: string, interactive: boolean, watchPresence = false) {
    const id = newIdentity(), uid = mintLifecycleUid();
    const creds = await mintCreds(auth, id, "agent", { principal: { owner, actor }, lifecycleUid: uid, ...(interactive ? { interactive: true as const } : {}) });
    return endpoint(creds, { id: id.id, name: actor, owner, actor }, uid, watchPresence);
  }
  const web = await principal(DEV_OWNER, "web", true, true);
  const sibling = await principal(DEV_OWNER, "helper", false);
  const teammate = await principal("bob", "web", true);

  const records = new Map<string, PermissionRecord>();
  const watch = await web.watchPermissions((c) => { if (c.kind === "put") records.set(c.record.id, c.record); });
  await watch.ready;

  const credsPath = join(root, "seat.creds");
  writeFileSync(credsPath, seatCreds, { mode: 0o600 });
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: config, ...xdg });
  const spec = claudeConnector.buildLaunch({
    space, name: "coder", id: seatId.id, creds: credsPath, servers: SERVERS, lifecycleUid: seatUid, model: "haiku",
    launchOptions: { "permission-mode": "default" }, resolvedBinaries: { claude: CLAUDE }, events: false,
  });
  const launcher = join(root, "launch.mjs");
  writeFileSync(launcher, `import { spawn } from "node:child_process";
const s = ${JSON.stringify({ command: spec.command, args: spec.args, env: { ...spec.env, HOME: home, CLAUDE_CONFIG_DIR: config, ...xdg, TERM: "xterm-256color" } })};
spawn(s.command, s.args, { env: s.env, stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 1));\n`);
  tmux("new-session", "-d", "-s", "seat", "-x", "200", "-y", "50", "-c", ws, process.execPath, launcher);

  const ready = await until(() => {
    const text = screen();
    if (text.includes("WARNING: Loading development channels")) tmux("send-keys", "-t", "seat", "Enter");
    return ["? for shortcuts", "(shift+tab to cycle)"].some((t) => text.includes(t)) && text;
  }, 60_000);
  const seatOnline = await until(() => web.getRoster().find((p) => p.lifecycleUid === seatUid && p.status !== "offline"), 30_000);
  check("claude starts in the pane and its seat joins the mesh", Boolean(ready && seatOnline), screen().slice(-800));

  const seat = (): Presence | undefined => web.getRoster().find((p) => p.lifecycleUid === seatUid);
  const idle = () => until(() => seat()?.status === "idle" && !screen().includes("Do you want to proceed?"), 90_000);
  const ask = async (marker: string): Promise<PermissionRecord | undefined> => {
    type(`Run this exact bash command and nothing else: touch ${marker}`);
    return until(() => [...records.values()].find((r) => r.input.kind === "shown" && JSON.stringify(r.input.value).includes(marker)), 90_000);
  };
  const stateOf = (id: string) => records.get(id)?.state;
  const ran = (marker: string) => existsSync(join(ws, marker));

  // ── 1. The owner approves; siblings and teammates cannot; a second answer is refused ──────────
  const a = await ask("marker-approve");
  check("a held prompt writes one pending record naming the seat, the tool, the full command and the directory",
    a !== undefined && a.agent === AGENT && a.tool === "Bash" && a.state.kind === "pending" && a.cwd === ws && a.holder.lifecycleUid === seatUid
      && a.input.kind === "shown" && (a.input.value as { command?: string }).command === "touch marker-approve", a);
  if (!a) throw new Error("no record for the first prompt; nothing below can run");
  await wait(8_000);
  const condition = seat()?.condition;
  check("eight seconds on, the prompt is still held and the seat's approval condition names it",
    stateOf(a.id)?.kind === "pending" && condition?.code === "approval" && condition.request === a.id, { state: stateOf(a.id), condition });
  const refused = [
    await sibling.answerPermission(AGENT, a.id, { decision: "approve" }),
    await teammate.answerPermission(AGENT, a.id, { decision: "approve" }),
  ];
  check(`a sibling agent and a teammate are refused by the broker (${refused.filter((o) => o.kind === "refused").length} of 2), and the prompt stays pending`,
    refused.every((o) => o.kind === "refused") && stateOf(a.id)?.kind === "pending", refused);
  const approved = await web.answerPermission(AGENT, a.id, { decision: "approve" });
  check("the owner's approval is accepted once Claude has it, by the owner's browser",
    approved.kind === "accepted" && approved.state.kind === "approved" && approved.state.by === `${DEV_OWNER}.web`, approved);
  check("...and the command runs", Boolean(await until(() => ran("marker-approve"), 60_000)), screen().slice(-600));
  const second = await web.answerPermission(AGENT, a.id, { decision: "deny", note: "too late" });
  check("a second answer is refused and names the first", second.kind === "answered" && second.state.kind === "approved" && second.state.by === `${DEV_OWNER}.web`, second);
  check("the record says the owner's browser approved it", (await until(() => stateOf(a.id)?.kind === "approved" && stateOf(a.id), 10_000))?.kind === "approved", stateOf(a.id));
  await idle();

  // ── 2. The owner denies with a note ───────────────────────────────────────────────────────────
  const NOTE = "use the staging bucket instead";
  const d = await ask("marker-deny");
  const denied = d && (await web.answerPermission(AGENT, d.id, { decision: "deny", note: NOTE }));
  check("the owner's denial with a note is accepted", denied !== undefined && denied.kind === "accepted" && denied.state.kind === "denied" && denied.state.note === NOTE, denied);
  await idle();
  const transcript = (() => {
    const dir = join(config, "projects");
    const files = existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
    const newest = files.sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0];
    return newest ? readFileSync(newest, "utf8") : "";
  })();
  check("...nothing runs", !ran("marker-deny"));
  check("...and Claude reads the note as the reason it was denied", transcript.includes(`Denied from Cotal: ${NOTE}`), transcript.slice(-1500));

  // ── 3. Yes at the terminal ────────────────────────────────────────────────────────────────────
  const y = await ask("marker-yes");
  await until(() => screen().includes("Do you want to proceed?"), 30_000);
  tmux("send-keys", "-t", "seat", "1");
  check("Yes at the terminal runs the command", Boolean(await until(() => ran("marker-yes"), 60_000)));
  const yes = y && (await until(() => stateOf(y.id)?.kind === "answered-on-machine" && stateOf(y.id), 30_000));
  check("...and the record says the machine allowed it", yes?.kind === "answered-on-machine" && yes.outcome === "allowed", y && stateOf(y.id));
  await idle();

  // ── 4. No at the terminal ─────────────────────────────────────────────────────────────────────
  const n = await ask("marker-no");
  await until(() => screen().includes("Do you want to proceed?"), 30_000);
  tmux("send-keys", "-t", "seat", "Escape");
  const no = n && (await until(() => stateOf(n.id)?.kind === "answered-on-machine" && stateOf(n.id), 30_000));
  check("No at the terminal leaves the command unrun and the record says the machine withdrew it",
    !ran("marker-no") && no?.kind === "answered-on-machine" && no.outcome === "withdrawn", n && stateOf(n.id));
  await until(() => ["? for shortcuts", "(shift+tab to cycle)"].some((t) => screen().includes(t)) && !screen().includes("Do you want to proceed?"), 30_000);

  // ── 5. The agent dies holding a prompt ────────────────────────────────────────────────────────
  const g = await ask("marker-gone");
  if (g) await until(() => screen().includes("Do you want to proceed?"), 30_000);
  tmux("kill-session", "-t", "seat");
  const offline = await until(() => seat()?.status === "offline" && seat(), 30_000);
  const liveness = g && holderLiveness(g.holder, offline ? { online: false, ...(offline.lifecycleUid ? { lifecycleUid: offline.lifecycleUid } : {}) } : undefined);
  check("after the agent dies its pending record reads gone", g !== undefined && liveness === "gone" && stateOf(g.id)?.kind === "pending", { liveness, state: g && stateOf(g.id) });
  const late = g && (await web.answerPermission(AGENT, g.id, { decision: "approve" }));
  check("...and an answer to it reads gone", late !== undefined && late.kind === "gone" && !ran("marker-gone"), late);

  const finals = [...records.values()].filter((r) => r.agent === AGENT).map((r) => r.state.kind === "answered-on-machine" ? `${r.state.kind}/${r.state.outcome}` : r.state.kind);
  console.log(`  records ${JSON.stringify(finals)}`);
  check(`the owner saw exactly five records, one per prompt (${finals.length})`,
    finals.length === 5 && ["approved", "denied", "answered-on-machine/allowed", "answered-on-machine/withdrawn", "pending"].every((s) => finals.includes(s)), finals);
} finally {
  tmux("kill-server");
  await Promise.all(endpoints.map((ep) => ep.stop().catch(() => {})));
  await killAndAwaitExit(srv);
  if (!process.env.COTAL_LIVE_KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  else console.log(`  kept ${root}`);
  releaseBroker();
}
finish();
