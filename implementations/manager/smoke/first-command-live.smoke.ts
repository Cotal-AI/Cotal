/**
 * LIVE: a launcher lists a harness's commands before launch and starts an agent with one as its
 * first turn. A real broker, the shipped auth service, the delivery daemon and a real Manager with
 * the pty runtime run against the real harnesses on PATH. Per harness (`LANE_HARNESSES`, default
 * claude,opencode,pi,codex), in a throwaway project outside any repository that holds one custom
 * command and one skill:
 *
 *  - a spawn-scoped launcher calls `harness-commands` and sees the project's entries;
 *  - it spawns an agent there with `firstCommand`, and the acceptance names its id;
 *  - the owner's interactive session reads that id's `command-state` on the agent until it ends;
 *  - the harness's own transcript shows how the command ran, which the suite prints.
 *
 * Hermes and jcode, whose seats run no commands, list `supported: false` and refuse a first command.
 *
 * Claude Code runs under the operator's own configuration. pi runs under a private
 * `PI_CODING_AGENT_DIR` that links the operator's pi auth and trusts the
 * project, and the space config forwards it to the seat, so its list and its seat both load the
 * project. Each agent is despawned, and the stack is torn down, at the end.
 *
 * Run: pnpm build, then pnpm smoke:first-command:live   (needs nats-server and the harnesses on PATH)
 */
import * as core from "../../../packages/core/dist/index.js";
import * as auth from "../../auth/dist/index.js";
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { createServer } = await import("node:http");
const { createRequire } = await import("node:module");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync } = await import("node:fs");
const { homedir, tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { SignJWT, generateKeyPair, exportJWK, decodeJwt } = createRequire(new URL("../../auth/package.json", import.meta.url))("jose") as any;
const { mintLifecycleUid, mintCreds, newIdentity, setupSpaceStreams, standaloneConnectOpts, issuedUserCaller, resolveService, invokeCommand, CotalEndpoint, AGENT_ENDPOINT } = core;
const { connect } = await import("@nats-io/transport-node");
const { startAuthService, grantActor } = auth;
const { startHostedAuthFixture } = await import("../../auth/smoke/_hosted-auth-fixture.js");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
const { nativeRemoteManager } = await import("./_native-remote-manager.js");
const { remoteManagerClient } = await import("../dist/index.js");
const { emitSentinel } = await import("@cotal-ai/smoke-kit");
for (const pkg of ["connector-claude-code", "connector-codex", "connector-opencode", "pi", "connector-hermes", "connector-jcode"]) await import(`../../../extensions/${pkg}/dist/index.js`);
// A Manager runs as the `cotal` binary, and a seat's bearer renewal re-runs this process's entry
// (`bearerEntryArgv`), so the entry here is the binary's, under this process's tsx loader.
process.argv[1] = new URL("../../../bin/cotal.ts", import.meta.url).pathname;
// The seats use the operator's own Claude Code configuration, where `cotal setup` declared the
// channel server, not that of a Claude Code session this suite may run under.
delete process.env.CLAUDE_CONFIG_DIR;

let passed = 0, failed = 0;
const cell = (name: string, ok: boolean, seen?: unknown) => {
  if (ok) { passed++; console.log(`PASS ${name}`); return; }
  failed++; console.log(`FAIL ${name}${seen === undefined ? "" : ` - ${JSON.stringify(seen)}`}`);
};
const note = (text: string) => console.log(`  ${text}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HARNESSES = (process.env.LANE_HARNESSES ?? "claude,opencode,pi,codex").split(",");

// ---- the throwaway project ----------------------------------------------------------------------
const project = realpathSync(mkdtempSync(join(tmpdir(), "lane-first-cmd-")));
const write = (rel: string, body: string) => { mkdirSync(join(project, rel, ".."), { recursive: true }); writeFileSync(join(project, rel), body); };
const cmdBody = (tag: string, args: string) => `---\ndescription: Lane first-command probe\n---\nReply with exactly ${tag} and then the topic: ${args}\n`;
const skillBody = "---\nname: lane-skill\ndescription: Lane first-command probe skill\n---\nWhen invoked, reply with exactly LANE-SKILL-RAN and then the arguments.\n";
write(".claude/commands/lane-cmd.md", cmdBody("LANE-CLAUDE-CMD-RAN", "$ARGUMENTS"));
write(".claude/skills/lane-skill/SKILL.md", skillBody);
write(".opencode/command/lane-cmd.md", cmdBody("LANE-OPENCODE-CMD-RAN", "$ARGUMENTS"));
write(".opencode/skill/lane-skill/SKILL.md", skillBody);
write(".pi/prompts/lane-cmd.md", cmdBody("LANE-PI-CMD-RAN", "$@"));
write(".agents/skills/lane-skill/SKILL.md", skillBody);
const piAgent = mkdtempSync(join(tmpdir(), "lane-pi-agent-"));
for (const f of ["auth.json"]) if (existsSync(join(homedir(), ".pi/agent", f))) symlinkSync(join(homedir(), ".pi/agent", f), join(piAgent, f));
for (const f of ["settings.json", "models-store.json"]) if (existsSync(join(homedir(), ".pi/agent", f))) copyFileSync(join(homedir(), ".pi/agent", f), join(piAgent, f));
writeFileSync(join(piAgent, "trust.json"), "{}");
const { ProjectTrustStore } = await import(join(realpathSync(join(homedir(), ".local/lib/node_modules/@earendil-works/pi-coding-agent")), "dist/index.js"));
new ProjectTrustStore(piAgent).set(project, true);
process.env.PI_CODING_AGENT_DIR = piAgent;

/** What each harness runs first: a command where its seats run commands, Codex's skill otherwise. */
const FIRST: Record<string, { target: "command" | "skill"; name: string; args: string }> = {
  claude: { target: "command", name: "lane-cmd", args: "first-command" },
  opencode: { target: "command", name: "lane-cmd", args: "first-command" },
  pi: { target: "command", name: "lane-cmd", args: "first-command" },
  codex: { target: "skill", name: "lane-skill", args: "first-command" },
};

// ---- the stack ----------------------------------------------------------------------------------
const pair = await generateKeyPair("EdDSA", { extractable: true });
const jwk = { ...await exportJWK(pair.publicKey), kid: "lane-idp", alg: "EdDSA", use: "sig" };
const idp = createServer((q, s) => { if (q.url !== "/api/auth/jwks") { s.writeHead(404); s.end(); return; } s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
const jwt = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject(sub).setIssuedAt().setExpirationTime("30m").sign(pair.privateKey);
const fx = await startHostedAuthFixture("lane-first", 1); const a = fx.accounts[0]!;
writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/api/auth/jwks` }), { mode: 0o600 });
const root = join(fx.dir, "participant"), controlRoot = join(fx.dir, "control");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); mkdirSync(controlRoot);
writeFileSync(join(root, ".cotal", "config.json"), JSON.stringify({ spawn: { env: ["PI_CODING_AGENT_DIR"] } }));
for (const h of HARNESSES) writeFileSync(join(root, ".cotal", "agents", `lane_${h}.md`), `---\nname: lane_${h}\n---\nYou are a probe. Do only what a command or the user asks.\n`);
const controlState = remoteManagerClient.loadOrCreateRemoteManagerIdentity(controlRoot, a.space);
const assignment = { v: 1 as const, space: a.space, accountPublicKey: a.accountPublicKey, instanceId: controlState.instanceId, lifecycleUid: controlState.lifecycleUid, assignmentRevision: 1, state: "assigned" as const };
const ownerSecret = (await auth.loadOwnerSecret(a.store, a.space))!;
const owner = auth.deriveOwnerForIdpSubject(ownerSecret, origin, "owner");
grantActor(a.stateDir, { owner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
grantActor(a.stateDir, { owner, actor: "launcher", lifecycleUid: mintLifecycleUid(), scope: ["spawn"], allowSubscribe: [], allowPublish: [] });
const token = await jwt("owner");
let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let participant: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let control: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let web: InstanceType<typeof CotalEndpoint> | undefined;
const callers: Awaited<ReturnType<typeof connect>>[] = [];
try {
  await setupSpaceStreams({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, publicFace: { port: 0, trustedProxy: false }, platformControl: { observeAssignment: async () => assignment } });
  const humanCall = async (request: any) => { const response = await fetch(`${service!.publicUrl}/manager-service-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken: token, request }) }); const body = await response.json() as any; if (!response.ok) throw new Error(`authority refused ${request.kind}: ${body.error}`); return body; };
  const controlCall = (request: any) => service!.platformControlAuthority!({ v: 1, kind: "platform-control-authority", space: a.space, accountPublicKey: a.accountPublicKey, assignmentRevision: 1, request });
  control = await nativeRemoteManager({ space: a.space, servers: fx.servers, root: controlRoot, exchangeUrl: service.publicUrl!, execution: "none", call: controlCall });
  participant = await nativeRemoteManager({ space: a.space, servers: fx.servers, root, exchangeUrl: service.publicUrl!, execution: "runtime", call: humanCall });
  const iid = participant.state.instanceId;

  const exchange = async (actor: string, view?: string) => {
    const response = await fetch(`${service!.publicUrl}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken: token, actor, ...(view ? { view, managerInstanceId: iid } : {}) }) });
    const body = await response.json() as any;
    assert.equal(response.status, 200, `exchange ${actor}: ${body.error}`);
    return body.token as string;
  };
  const launcherToken = await exchange("launcher", "manager-caller");
  const options = standaloneConnectOpts({ bearer: launcherToken, sentinelCreds: a.sentinelCreds, tls: false });
  const nc = await connect({ servers: fx.servers, ...options }); callers.push(nc);
  const issued = await issuedUserCaller(nc, a.space, String(options.name), { owner, actor: "launcher", uid: (decodeJwt(launcherToken) as any).act.lifecycleUid });
  const manager = await resolveService(nc, a.space, "manager", issued, { instanceId: iid });
  const call = async (command: string, args?: Record<string, unknown>, deadlineMs = 30_000) => {
    const r = await invokeCommand(nc, a.space, manager, command, args, { deadlineMs });
    return r.reply.ok ? { ok: true as const, data: r.reply.data as any } : { ok: false as const, error: r.reply.error };
  };

  // The owner's interactive session, which alone may read an agent's command state (SPEC 13.22).
  grantActor(a.stateDir, { owner, actor: "web", lifecycleUid: mintLifecycleUid(), scope: [], allowSubscribe: [], allowPublish: [] });
  const webToken = await exchange("web");
  web = new CotalEndpoint({ space: a.space, servers: fx.servers, bearer: () => webToken, sentinelCreds: a.sentinelCreds, lifecycleUid: (decodeJwt(webToken) as any).act.lifecycleUid,
    card: { owner, actor: "web", name: "web", kind: "agent" }, channels: [], consume: false, watchChannels: false, registerPresence: false, watchPresence: true } as never);
  web.on("error", () => {});
  await web.start();

  for (const h of ["hermes", "jcode"]) {
    const listed = await call("harness-commands", { agent: h, cwd: project });
    cell(`${h}: harness-commands answers supported: false, with the reason`, listed.ok && listed.data.supported === false && typeof listed.data.reason === "string", listed.ok ? listed.data : listed.error);
    const refused = await call("spawn", { name: `lane_${h}`, agent: h, cwd: project, events: false, firstCommand: { target: "command", name: "lane-cmd" } });
    cell(`${h}: a spawn naming a first command is refused before launch`, !refused.ok && refused.error?.code === "failed-precondition" && refused.error?.outcome === "not-executed", refused.ok ? refused.data : refused.error);
  }

  for (const h of HARNESSES) {
    console.log(`--- ${h}`);
    const first = FIRST[h]!;
    const listed = await call("harness-commands", { agent: h, cwd: project });
    const lane = listed.ok && listed.data.supported ? listed.data.commands.filter((e: any) => e.name.startsWith("lane-")) : [];
    cell(`${h}: harness-commands lists the project's entries before launch`, listed.ok && listed.data.supported && lane.some((e: any) => e.name === first.name && e.target === first.target), listed.ok ? { supported: listed.data.supported, lane, reason: listed.data.reason } : listed.error);
    note(`listed: ${JSON.stringify(lane)}`);

    // A Claude seat defaults to bypassPermissions, whose one-time acceptance only a person gives.
    const launchOptions = h === "claude" ? { launchOptions: { "permission-mode": "default" } } : {};
    const spawned = await call("spawn", { name: `lane_${h}`, agent: h, cwd: project, events: false, ...launchOptions, firstCommand: first }, 60_000);
    const id = spawned.ok ? spawned.data.firstCommand?.id : undefined;
    cell(`${h}: spawn accepts the first command and names its id`, typeof id === "string" && /^[a-z2-7]{26}$/.test(id), spawned.ok ? spawned.data : spawned.error);
    if (!spawned.ok || id === undefined) continue;
    const name = spawned.data.name as string;

    let principal: import("@cotal-ai/core").EpPrincipal | undefined;
    for (let i = 0; i < 180 && !principal; i++) {
      const p = web.getRoster().find((r: any) => r.card.id === `${owner}.${name}` && r.runtime?.id);
      if (p) principal = { owner, actor: name, uid: (p as any).lifecycleUid, runtimeId: (p as any).runtime.id };
      else await wait(1000);
    }
    const goal = await call("goal-result", { goalId: spawned.data.goalId });
    cell(`${h}: the agent joined the mesh`, principal !== undefined, goal.ok ? goal.data : goal.error);
    if (!principal) continue;

    let state: any;
    for (let i = 0; i < 120; i++) {
      const r = await web.callPrincipal({ endpoint: AGENT_ENDPOINT, principal, command: "command-state", authority: "owner", args: { id }, deadlineMs: 15_000 }).catch((e: Error) => ({ ok: false, error: { message: e.message } }) as any);
      state = r.ok ? r.data.state : { read: r.error };
      if (state?.kind && state.kind !== "queued" && state.kind !== "taken") break;
      await wait(1000);
    }
    cell(`${h}: the first command's state on the agent reads started`, state?.kind === "started", state);
    note(`command-state: ${JSON.stringify(state)}`);
    await wait(25_000); // let the command's turn write its transcript
    note(`transcript: ${transcriptEvidence(h, name)}`);
    const r = await invokeCommand(nc, a.space, manager, "despawn", { graceful: false }, { deadlineMs: 30_000, target: { mode: "owner", owner, actor: name, lifecycleUid: principal.uid } }).catch((e: Error) => ({ reply: { ok: false, error: { message: e.message } } }) as any);
    note(`despawn: ${JSON.stringify(r.reply.ok ? r.reply.data : r.reply.error)}`);
  }
} catch (error) {
  failed++; console.log(`FAIL fixture: ${(error as Error).stack}`);
} finally {
  await web?.stop().catch(() => {});
  for (const nc of callers) await nc.close().catch(() => {});
  await participant?.manager.stop({ withAgents: true }); await control?.manager.stop();
  try { await service?.close(); } finally { await delivery?.stop(); await fx.close(); await new Promise<void>((r) => idp.close(() => r())); }
  rmSync(piAgent, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

/** Where the harness recorded the command, read from its own transcript store. */
function transcriptEvidence(h: string, name: string): string {
  try {
    if (h === "claude") {
      const dir = join(homedir(), ".claude", "projects", project.replace(/[/.]/g, "-"));
      const newest = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)).sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0]!;
      const lines = readFileSync(newest, "utf8").split("\n").filter((l) => /"type":"(user|assistant)"/.test(l) && (l.includes("lane-cmd") || l.includes("LANE-CLAUDE")));
      return lines.map((l) => { const j = JSON.parse(l); return `${j.type}: ${String(JSON.stringify(j.message?.content ?? "")).slice(0, 240)}`; }).join(" | ");
    }
    if (h === "pi") {
      const dirs = readdirSync(join(piAgent, "sessions"), { recursive: true }) as string[];
      const files = dirs.filter((f) => f.endsWith(".jsonl")).map((f) => join(piAgent, "sessions", f));
      const lines = files.flatMap((f) => readFileSync(f, "utf8").split("\n")).filter((l) => /LANE-PI|lane-cmd/.test(l));
      return lines.map((l) => l.slice(0, 300)).join(" | ");
    }
    if (h === "opencode") {
      const base = join(root, ".cotal", "opencode");
      const dbs = (readdirSync(base, { recursive: true }) as string[]).filter((f) => f.endsWith(".db")).map((f) => join(base, f));
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const out: string[] = [];
      for (const path of dbs) {
        const db = new DatabaseSync(path, { readOnly: true });
        for (const t of db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]) {
          for (const row of db.prepare(`select * from "${t.name}"`).all() as Record<string, unknown>[]) {
            const text = JSON.stringify(row);
            if (/LANE-OPENCODE|lane-cmd/.test(text)) out.push(`${t.name}: ${text.slice(0, 400)}`);
          }
        }
        db.close();
      }
      return out.join(" | ") || `no entry in ${dbs.join(",")}`;
    }
    return `not read for ${h} (${name})`;
  } catch (e) {
    return `unreadable: ${(e as Error).message}`;
  }
}

console.log(`first command live: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
