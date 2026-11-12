/**
 * Claude Code's permission prompts, answered by the agent's owner from another session, on a real
 * broker with a real interactive Claude Code.
 *
 * The space runs the shipped auth callout over a real ledger. The seat is a managed-agent row that
 * connects with a bearer, launched through the shipped `buildLaunch` with `permission-mode=default`,
 * its MCP server and hook bundles, and `claude` itself in a tmux pane. The owner's browser actor `web`
 * is an interactive ledger row: it watches the records through its own reader, which a provisioner
 * opens, and answers. Each case asks Claude to run one `touch`, so the file says whether it ran.
 *
 *  1. The owner approves after holding the prompt past the relay's 2 s deadline: the command runs,
 *     and the record says who approved. A sibling agent and a teammate are refused by the broker,
 *     and a second answer is refused naming the first.
 *  2. The owner denies with a note: nothing runs, and Claude reads the note as the reason.
 *  3. Yes at the terminal: the command runs and the record says the machine allowed it.
 *  4. No at the terminal: nothing runs and the record says the machine withdrew it.
 *  5. A background subagent asks, and the main thread finishes another turn meanwhile: the subagent's
 *     prompt stays pending, and the owner's approval still runs its command.
 *  6. The agent dies holding a prompt: readers derive `gone`, and an answer reads `gone`.
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
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { generateKeyPair, SignJWT } from "jose";
import {
  CotalEndpoint, createSpaceAuth, holderLiveness, isReachable, mintCreds, mintLifecycleUid, newIdentity, principalId,
  provisionAgentDurables, serverConfig, setupSpaceStreams, type PermissionRecord, type Presence,
} from "@cotal-ai/core";
import {
  calloutPermissions, createCalloutAuth, deriveOwnerToken, grantActor, grantManagedActor, ledgerAclResolver, ledgerAuthorizeConnect,
  newActorToken, startAuthCallout, USER_TOKEN_VER,
} from "@cotal-ai/auth";
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
const enc = new TextEncoder();
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
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port: PORT, storeDir: join(root, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
}));
const srv = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, root);
const TMUX = ["-L", `cotal-perm-${randomUUID().slice(0, 8)}`];
const tmux = (...args: string[]) => spawnSync("tmux", [...TMUX, ...args], { encoding: "utf8" });
const screen = () => tmux("capture-pane", "-p", "-t", "seat").stdout ?? "";

const OWNER = deriveOwnerToken("s".repeat(32), "permission-live|owner");
const BOB = deriveOwnerToken("s".repeat(32), "permission-live|bob");
const ISSUER = "https://permission-live.test";
const endpoints: CotalEndpoint[] = [];
const raws: NatsConnection[] = [];
const artifacts: string[] = [];
try {
  for (let i = 0; i < 50 && !(await isReachable(SERVERS)); i++) await wait(200);
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionerCreds });
  async function endpoint(card: { name: string; owner?: string; actor?: string }, auth: { creds: string } | { bearer: string }, lifecycleUid: string, watchPresence = false) {
    const ep = new CotalEndpoint({
      space, servers: SERVERS, lifecycleUid, channels: [], consume: false, watchPresence, registerPresence: false, watchChannels: false,
      card: { kind: "agent", ...card }, ...("creds" in auth ? { creds: auth.creds } : { bearer: auth.bearer, sentinelCreds: callout.sentinelCreds }),
    });
    ep.on("error", () => {});
    await ep.start();
    endpoints.push(ep);
    return ep;
  }
  const provisioner = await endpoint({ name: "provisioner" }, { creds: provisionerCreds }, mintLifecycleUid());

  // The ledger: the seat and its sibling are managed-agent rows, the browsers are interactive rows.
  const ledger = join(root, "ledger");
  const seatUid = mintLifecycleUid(), helperUid = mintLifecycleUid();
  const managed = (actor: string, lifecycleUid: string) => grantManagedActor(ledger, {
    owner: OWNER, actor, scope: [], allowSubscribe: [], allowPublish: [], lifecycleUid, tokenHash: newActorToken().tokenHash, custody: { kind: "foreground" },
  });
  managed("coder", seatUid);
  managed("helper", helperUid);
  const webRow = grantActor(ledger, { owner: OWNER, actor: "web", scope: [], allowSubscribe: [], allowPublish: [] });
  const bobRow = grantActor(ledger, { owner: BOB, actor: "web", scope: [], allowSubscribe: [], allowPublish: [] });
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc.encode(callout.calloutCreds)), maxReconnectAttempts: 0 });
  raws.push(calloutNc);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space, token: { key: publicKey as never, issuer: ISSUER },
    recordIssuance: async () => {},
    authorizeActor: ledgerAuthorizeConnect(ledger),
    permissionsFor: calloutPermissions(ledgerAclResolver(ledger)),
    log: (line) => { if (/denied|drop|fail/i.test(line)) console.log("  [callout]", line); },
  });
  const bearer = (owner: string, actor: string, lifecycleUid: string) =>
    new SignJWT({ sub: owner, ver: USER_TOKEN_VER, act: { owner, actor, scope: [], lifecycleUid } })
      .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISSUER).setAudience(space).setSubject(owner)
      .setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000) - 60).setExpirationTime("14m").sign(privateKey); // the callout caps a bearer at 15 min

  await provisionAgentDurables(provisioner, { owner: OWNER, actor: "coder", lifecycleUid: seatUid }, { subscribe: [], allowSubscribe: [] });
  const AGENT = principalId(OWNER, "coder");
  const web = await endpoint({ name: "web", owner: OWNER, actor: "web" }, { bearer: await bearer(OWNER, "web", webRow.lifecycleUid!) }, webRow.lifecycleUid!, true);
  const sibling = await endpoint({ name: "helper", owner: OWNER, actor: "helper" }, { bearer: await bearer(OWNER, "helper", helperUid) }, helperUid);
  const teammate = await endpoint({ name: "web", owner: BOB, actor: "web" }, { bearer: await bearer(BOB, "web", bobRow.lifecycleUid!) }, bobRow.lifecycleUid!);

  const watch = await web.watchPermissions((reader) => provisioner.openPermissionReader(reader));
  await watch.ready;
  const records = () => watch.records();

  // The seat's bearer and the sentinel ride 0600 files; only their paths reach the launch.
  const bearerPath = join(root, "seat.bearer"), sentinelPath = join(root, "sentinel.creds");
  writeFileSync(bearerPath, await bearer(OWNER, "coder", seatUid), { mode: 0o600 });
  writeFileSync(sentinelPath, callout.sentinelCreds, { mode: 0o600 });
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: config, ...xdg });
  const spec = claudeConnector.buildLaunch({
    space, name: "coder", servers: SERVERS, lifecycleUid: seatUid, model: "haiku",
    launchOptions: { "permission-mode": "default" }, resolvedBinaries: { claude: CLAUDE }, events: false,
    userAuth: {
      owner: OWNER, actor: "coder", sentinelCredsPath: sentinelPath,
      bearerCmd: [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", bearerPath],
    },
  });
  artifacts.push(...(spec.artifacts ?? []));
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
  check("claude starts in the pane and its user-mode seat joins the mesh", Boolean(ready && seatOnline), screen().slice(-800));

  const seat = (): Presence | undefined => web.getRoster().find((p) => p.lifecycleUid === seatUid);
  // Claude reads keys typed in one burst as a paste and can drop an Enter inside it, which leaves the
  // prompt unsent. Enter goes as its own keystroke until the seat's UserPromptSubmit hook says the
  // turn started.
  const type = async (text: string): Promise<void> => {
    tmux("send-keys", "-t", "seat", "-l", text);
    for (let tries = 0; tries < 3; tries++) {
      await wait(500);
      tmux("send-keys", "-t", "seat", "Enter");
      if (await until(() => seat()?.status === "working", 5_000)) return;
    }
  };
  const idle = () => until(() => seat()?.status === "idle" && !screen().includes("Do you want to proceed?"), 90_000);
  const recordOf = (marker: string) => records().find((r) => r.input.kind === "shown" && JSON.stringify(r.input.value).includes(marker));
  const ask = async (marker: string, prompt = `Run this exact bash command and nothing else: touch ${marker}`): Promise<PermissionRecord | undefined> => {
    await type(prompt);
    return until(() => recordOf(marker), 90_000);
  };
  const stateOf = (id: string) => records().find((r) => r.id === id)?.state;
  const ran = (marker: string) => existsSync(join(ws, marker));

  // ── 1. The owner approves; siblings and teammates cannot; a second answer is refused ──────────
  const a = await ask("marker-approve");
  check("a held prompt writes one pending record naming the seat, the tool, the full command and the directory",
    a !== undefined && a.agent === AGENT && a.tool === "Bash" && a.state.kind === "pending" && a.cwd === ws && a.holder.lifecycleUid === seatUid
      && a.input.kind === "shown" && (a.input.value as { command?: string }).command === "touch marker-approve", a ?? screen());
  if (!a) throw new Error("no record for the first prompt; nothing below can run");
  await wait(8_000);
  const condition = seat()?.condition;
  check("eight seconds on, the prompt is still held and the seat's approval condition names it",
    stateOf(a.id)?.kind === "pending" && condition?.code === "approval" && condition.request === a.id, { state: stateOf(a.id), condition });
  const refused = [
    await sibling.answerPermission(a, { decision: "approve" }),
    await teammate.answerPermission(a, { decision: "approve" }),
  ];
  check(`a sibling agent and a teammate are refused by the broker (${refused.filter((o) => o.kind === "refused").length} of 2), and the prompt stays pending`,
    refused.every((o) => o.kind === "refused") && stateOf(a.id)?.kind === "pending", refused);
  const approved = await web.answerPermission(a, { decision: "approve" });
  check("the owner's approval is accepted once Claude has it, by the owner's browser",
    approved.kind === "accepted" && approved.state.kind === "approved" && approved.state.by === `${OWNER}.web`, approved);
  check("...and the command runs", Boolean(await until(() => ran("marker-approve"), 60_000)), screen().slice(-600));
  const second = await web.answerPermission(a, { decision: "deny", note: "too late" });
  check("a second answer is refused and names the first", second.kind === "answered" && second.state.kind === "approved" && second.state.by === `${OWNER}.web`, second);
  check("the record says the owner's browser approved it", (await until(() => stateOf(a.id)?.kind === "approved" && stateOf(a.id), 10_000))?.kind === "approved", stateOf(a.id));
  await idle();

  // ── 2. The owner denies with a note ───────────────────────────────────────────────────────────
  const NOTE = "use the staging bucket instead";
  const d = await ask("marker-deny");
  const denied = d && (await web.answerPermission(d, { decision: "deny", note: NOTE }));
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

  // ── 5. A background subagent's prompt outlives the main turn's end ────────────────────────────
  // Claude runs a subagent in the background and keeps the main thread free; the subagent's prompt
  // carries its agent_id, and the main thread's Stop must not settle it.
  const s = await ask("marker-sub", "Use the Agent tool with subagent_type general-purpose. Tell the subagent to run exactly this bash command and nothing else: touch marker-sub");
  await idle();
  await type("Reply with the single word ok and nothing else.");
  const turnEnded = await idle();
  await wait(2_000);
  check("a background subagent's prompt stays pending after the main thread finishes another turn",
    s !== undefined && Boolean(turnEnded) && stateOf(s.id)?.kind === "pending" && !ran("marker-sub"), { state: s && stateOf(s.id), status: seat()?.status });
  const subApproved = s && (await web.answerPermission(s, { decision: "approve" }));
  check("...and the owner's approval of it is accepted and runs the subagent's command",
    subApproved?.kind === "accepted" && Boolean(await until(() => ran("marker-sub"), 60_000)), { subApproved, state: s && stateOf(s.id) });
  await idle();

  // ── 6. The agent dies holding a prompt ────────────────────────────────────────────────────────
  const g = await ask("marker-gone");
  if (g) await until(() => screen().includes("Do you want to proceed?"), 30_000);
  tmux("kill-session", "-t", "seat");
  const offline = await until(() => seat()?.status === "offline" && seat(), 30_000);
  const liveness = g && holderLiveness(g.holder, offline ? { online: false, ...(offline.lifecycleUid ? { lifecycleUid: offline.lifecycleUid } : {}) } : undefined);
  check("after the agent dies its pending record reads gone", g !== undefined && liveness === "gone" && stateOf(g.id)?.kind === "pending", { liveness, state: g && stateOf(g.id) });
  const late = g && (await web.answerPermission(g, { decision: "approve" }));
  check("...and an answer to it reads gone", late !== undefined && late.kind === "gone" && !ran("marker-gone"), late);

  const finals = records().filter((r) => r.agent === AGENT).map((r) => r.state.kind === "answered-on-machine" ? `${r.state.kind}/${r.state.outcome}` : r.state.kind);
  console.log(`  records ${JSON.stringify(finals)}`);
  const expected = ["approved", "denied", "answered-on-machine/allowed", "answered-on-machine/withdrawn", "approved", "pending"];
  check(`the owner saw exactly six records, one per prompt, oldest first (${finals.length})`, finals.join() === expected.join(), finals);
  await watch.stop();
} finally {
  tmux("kill-server");
  await Promise.all(endpoints.map((ep) => ep.stop().catch(() => {})));
  for (const nc of raws) await nc.close().catch(() => {});
  await killAndAwaitExit(srv);
  for (const path of artifacts) rmSync(path, { recursive: true, force: true });
  if (!process.env.COTAL_LIVE_KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  else console.log(`  kept ${root}`);
  releaseBroker();
}
finish();
