/**
 * Launch-grammar override threading smoke (CLI rework stage 2a) — proves the `start` control op's
 * NEW knobs behave end to end without a broker or a real harness launch, driving the real
 * `startAgent` with a fake runtime + `ep` stub (same harness as start-model-preflight.smoke.ts).
 * Covers the merged `cotal spawn --detach` grammar manager-side:
 *   1. ACL OVERRIDES — opts.subscribe/allowSubscribe/allowPublish WIN over the persona file and
 *      thread into LaunchOpts (the same flags > file precedence as foreground `cotal spawn`).
 *   2. PROMPT — opts.prompt rides StartAgentOpts → LaunchOpts verbatim.
 *   3. SHARE-TOOLS — the selection narrows the config's declared MCP servers: named subset rides
 *      through; `none` shares nothing; absent shares all declared; an undeclared name FAILS the
 *      spawn loudly (no silent drop).
 *   4. RESOLVED GUARD — a manifest launch (`resolved`) REJECTS imperative overrides.
 *   5. allowSubscribe default follows an overridden subscribe (override → creds source is one).
 *   6. COTAL_DEFAULT_AGENT picks the manager's default harness when opts.agent is absent.
 *   7. A detached caller default sits below an explicit flag and persona pin, but above the
 *      manager's own environment default.
 * Run: pnpm smoke:start-overrides
 */
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import { firstFreeName } from "@cotal-ai/core";

/** Match `<base>` or `<base><sep><n>` where SEP is the shipped auto-numbering separator, DERIVED
 *  rather than spelled. Both cells below used to hard-code `-`, so changing the numbering scheme
 *  surfaced here as a CI failure instead of as a deliberate update — an assertion that spells a
 *  convention silently pins it. Derived, this follows the scheme wherever it goes. */
const NUM_SEP = firstFreeName("a", (n) => n === "a").slice(1, 2);
const autoNumbered = (base: string) => new RegExp(`^${base}(${NUM_SEP}\\d+)?$`);
import { principalKey, registry, DEV_OWNER, type Connector, type LaunchOpts, type LaunchSpec, type AgentHandle, type MeshLaunchAgent } from "@cotal-ai/core";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

// Workspace: personas with and without access frontmatter, plus a cotal config declaring two
// shareable MCP servers for the recording connector type.
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-start-ov-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
writeFileSync(join(agentsDir, "plain.md"), "---\nname: plain\n---\n");
writeFileSync(
  join(agentsDir, "team.md"),
  "---\nname: team\nsubscribe: [team]\nallowSubscribe: [team, team.>]\nallowPublish: [team]\n---\n",
);
writeFileSync(
  join(workspaceRoot, ".cotal", "config.json"),
  JSON.stringify({
    connectors: { "smoke-ov": { mcpServers: { alpha: { command: "true" }, beta: { command: "true" } } } },
  }),
);
// A project config that declares servers applies only in a folder the operator trusts. The trust
// record lives in this suite's own config folder.
process.env.XDG_CONFIG_HOME = join(workspaceRoot, "xdg");
const { trustProject } = await import("@cotal-ai/workspace");
trustProject(workspaceRoot);

const mgr = new Manager({ space: "smoke", servers: undefined, runtime: "pty", workspaceRoot });
const fakeSession = {
  cols: 80, rows: 24, backlog: () => Buffer.alloc(0),
  onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {},
};
const fakeHandle = (name: string): AgentHandle => ({
  name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession,
});
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
  kind: "fake",
  spawn: (name) => fakeHandle(name),
};
(mgr as unknown as { ep: object }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  // #159 B1 readiness race: on/off (event is only a wake) + getRoster reporting every managed agent
  // joined — same fake as manifest-launch.smoke.ts, so a successful spawn resolves "started".
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  getRoster: () => [...(mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid })),
};

// The connector callback below is what assigns this, and the checker cannot follow a call into
// a registered extension. A bare `x = undefined` reset therefore narrows the binding to
// `undefined` for the rest of the block and every later read reports on `never`, so the reset
// goes through a call, which leaves the declared type in place. Runtime behaviour is identical.
let lastOpts: LaunchOpts | undefined;
const resetOpts = () => { lastOpts = undefined; };
const recCon: Connector = {
  kind: "connector",
  name: "smoke-ov",
  requires: ["node"],
  supportsPrompt: true, // block 4 starts it with a prompt; the contract is default-deny (#315)
  buildLaunch: (o) => { lastOpts = o; return { command: "true", args: [], env: {} }; },
};
registry.register(recCon);
const callerCon: Connector = {
  ...recCon,
  name: "caller-default",
};
const managerCon: Connector = {
  ...recCon,
  name: "manager-default",
};
registry.register(callerCon);
registry.register(managerCon);

const j = (v: unknown) => JSON.stringify(v);

// 1 — ACL overrides win over the persona file (flags > file, foreground-parity precedence).
{
  resetOpts();
  const reply = await mgr.startAgent({
    name: "team",
    agent: "smoke-ov",
    events: false,
    subscribe: ["review", "review.x"],
    allowSubscribe: ["review", "review.>"],
    allowPublish: ["review.>"],
  });
  check("override spawn succeeds", reply.ok === true, reply);
  check("subscribe override wins over file", j(lastOpts?.subscribe) === j(["review", "review.x"]), lastOpts?.subscribe);
  check("allowSubscribe override wins over file", j(lastOpts?.allowSubscribe) === j(["review", "review.>"]), lastOpts?.allowSubscribe);
  check("allowPublish override wins over file", j(lastOpts?.allowPublish) === j(["review.>"]), lastOpts?.allowPublish);
}

// 2 — no overrides → the persona file still rules (regression guard on the new precedence code).
{
  resetOpts();
  await mgr.startAgent({ name: "team", agent: "smoke-ov", events: false });
  check("no override → file subscribe", j(lastOpts?.subscribe) === j(["team"]), lastOpts?.subscribe);
  check("no override → file allowPublish", j(lastOpts?.allowPublish) === j(["team"]), lastOpts?.allowPublish);
}

// 3 — allowSubscribe defaults from the OVERRIDDEN subscribe (one source feeds creds + connector).
{
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", subscribe: ["ops"], events: false });
  check("allowSubscribe defaults from overridden subscribe", j(lastOpts?.allowSubscribe) === j(["ops"]), lastOpts?.allowSubscribe);
}

// 4 — prompt threads verbatim.
{
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", prompt: "hello team", events: false });
  check("prompt threads into LaunchOpts.prompt", lastOpts?.prompt === "hello team", lastOpts?.prompt);
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", events: false });
  check("no --prompt → LaunchOpts.prompt undefined", lastOpts?.prompt === undefined, lastOpts?.prompt);
}

// 5 — share-tools selection narrows the declared servers; `[]` = none; absent = all; unknown fails.
{
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", events: false });
  check("absent shareTools → all declared servers", j(Object.keys(lastOpts?.mcpServers ?? {})) === j(["alpha", "beta"]), lastOpts?.mcpServers);
  check("absent shareTools keeps native MCP discovery", lastOpts?.mcpServersExclusive === false);
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: ["alpha"], events: false });
  check("named selection → that server only", j(Object.keys(lastOpts?.mcpServers ?? {})) === j(["alpha"]), lastOpts?.mcpServers);
  check("named shareTools requests exclusive MCP discovery", lastOpts?.mcpServersExclusive === true);
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: [], events: false });
  check("empty shareTools → no servers", j(Object.keys(lastOpts?.mcpServers ?? {})) === j([]), lastOpts?.mcpServers);
  check("empty shareTools requests exclusive MCP discovery", lastOpts?.mcpServersExclusive === true);
  const bad = await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: ["gamma"], events: false });
  check("undeclared share-tools name fails loud", bad.ok === false && /gamma/.test(bad.error ?? ""), bad);
  // #3864: the selection is a pure function of the request and the config, so the refusal lands
  // BEFORE the spawn is accepted. Before the fix onAccepted had fired (and a hosted run had bound
  // its goal) by the time hostLaunchFields refused the name.
  let accepted = false;
  let refusal: string | undefined;
  try {
    const r = await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: ["gamma"], events: false }, undefined, {
      onAccepted: async () => { accepted = true; },
    });
    if (r.ok === false) refusal = r.error;
  } catch (e) {
    refusal = e instanceof Error ? e.message : String(e);
  }
  check("undeclared share-tools name is refused before the spawn is accepted (onAccepted never fires)",
    refusal !== undefined && /gamma/.test(refusal) && accepted === false, { refusal, accepted });
}

// 6 — the identity override (`--name` alongside a ref) wins over the file's `name:` and threads
// into both the reply and LaunchOpts (foreground's `requested = values.name ?? def.name` parity).
{
  resetOpts();
  const r = await mgr.startAgent({ name: "team", agent: "smoke-ov", identity: "scout", events: false });
  check("identity override spawns", r.ok === true, r);
  check("identity override wins over file name:", (r.data as { name?: string })?.name === "scout", r.data);
  check("identity threads into LaunchOpts.name", lastOpts?.name === "scout", lastOpts?.name);
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", events: false });
  // Earlier sections spawned `plain` repeatedly — uniqueName auto-numbers, so match the series.
  check(`instrument control: the shipped numbering separator is one mintable char (${JSON.stringify(NUM_SEP)})`,
    NUM_SEP.length === 1 && /^[A-Za-z0-9_]$/.test(NUM_SEP), NUM_SEP);
  check("no identity override → file name: (auto-numbered)", autoNumbered("plain").test(lastOpts?.name ?? ""), lastOpts?.name);
}

// 7 — a manifest launch (resolved) rejects imperative overrides (access + identity authority).
{
  const resolved: MeshLaunchAgent = {
    name: "mfst",
    agent: "smoke-ov",
    subscribe: ["m"],
    allowSubscribe: ["m"],
    allowPublish: ["m"],
  } as MeshLaunchAgent;
  const cfg = join(agentsDir, "plain.md"); // any existing file — resolved supplies the identity
  const r1 = await mgr.startAgent({ name: "mfst", agent: "smoke-ov", config: cfg, resolved, prompt: "x", events: false });
  check("resolved + prompt rejected", r1.ok === false && /rejects imperative overrides/.test(r1.error ?? ""), r1);
  const r2 = await mgr.startAgent({ name: "mfst", agent: "smoke-ov", config: cfg, resolved, subscribe: ["x"], events: false });
  check("resolved + subscribe rejected", r2.ok === false && /rejects imperative overrides/.test(r2.error ?? ""), r2);
  const r3 = await mgr.startAgent({ name: "mfst", agent: "smoke-ov", config: cfg, resolved, identity: "x", events: false });
  check("resolved + identity rejected", r3.ok === false && /rejects imperative overrides/.test(r3.error ?? ""), r3);
}

// 8 — COTAL_DEFAULT_AGENT supplies the manager-side default harness.
{
  const prev = process.env.COTAL_DEFAULT_AGENT;
  process.env.COTAL_DEFAULT_AGENT = "smoke-ov";
  try {
    resetOpts();
    const r = await mgr.startAgent({ name: "plain", events: false });
    check("COTAL_DEFAULT_AGENT spawn succeeds", r.ok === true, r);
    check("COTAL_DEFAULT_AGENT used as manager default", (r.data as { agent?: string })?.agent === "smoke-ov", r.data);
    check("env default reaches LaunchOpts", lastOpts?.space === "smoke" && autoNumbered("plain").test(lastOpts?.name ?? ""), { space: lastOpts?.space, name: lastOpts?.name });
  } finally {
    if (prev === undefined) delete process.env.COTAL_DEFAULT_AGENT;
    else process.env.COTAL_DEFAULT_AGENT = prev;
  }
}

// 9 — #869: the persona file's `agent:` pin picks the harness. The defect this issue names: the
// connector was resolved BEFORE loadAgentFile on this exact path, so the file's pin could never
// participate, and a pinned persona silently ran whatever the env/default chose.
{
  writeFileSync(
    join(agentsDir, "pinned.md"),
    "---\nname: pinned\nagent: smoke-ov\nsubscribe: []\n---\npinned persona\n",
  );
  const recOther: Connector = {
    kind: "connector",
    name: "smoke-other",
    requires: ["node"],
    buildLaunch: (o) => { lastOpts = o; return { command: "true", args: [], env: {} }; },
  };
  registry.register(recOther);
  const prev = process.env.COTAL_DEFAULT_AGENT;
  process.env.COTAL_DEFAULT_AGENT = "smoke-other";
  try {
    resetOpts();
    const r = await mgr.startAgent({ name: "pinned", events: false }); // no --agent, env points elsewhere
    check("file pin spawn succeeds", r.ok === true, r);
    check("persona agent: pin picks the harness (file beats env)", (r.data as { agent?: string })?.agent === "smoke-ov", r.data);
    check("the pinned connector built the launch", lastOpts !== undefined && /^pinned(-\d+)?$/.test(lastOpts.name ?? ""), lastOpts?.name);
    resetOpts();
    const f = await mgr.startAgent({ name: "pinned", agent: "smoke-other", events: false }); // explicit flag wins
    check("flag spawn succeeds", f.ok === true, f);
    check("explicit --agent wins over the file pin", (f.data as { agent?: string })?.agent === "smoke-other", f.data);
  } finally {
    if (prev === undefined) delete process.env.COTAL_DEFAULT_AGENT;
    else process.env.COTAL_DEFAULT_AGENT = prev;
  }
  // The loud guard: a pin naming an unregistered connector fails the spawn (no silent default).
  writeFileSync(join(agentsDir, "typo.md"), "---\nname: typo\nagent: no-such-connector\nsubscribe: []\n---\nx\n");
  const t = await mgr.startAgent({ name: "typo", events: false });
  check("a pin naming an unregistered connector fails loud", t.ok === false && /no-such-connector/.test(t.error ?? ""), t);
  // An UNPINNED persona with an explicit flag is unaffected by any of the above (pin must not leak).
  delete process.env.COTAL_DEFAULT_AGENT;
  const d = await mgr.startAgent({ name: "plain", agent: "smoke-other", events: false });
  check("unpinned persona still honors the flag", (d.data as { agent?: string })?.agent === "smoke-other", d.data);
}

// 10 — a detached caller's environment default is a distinct precedence layer. It must survive
// dispatch when the manager's environment differs, without becoming an explicit override that can
// beat the persona file.
{
  const prev = process.env.COTAL_DEFAULT_AGENT;
  process.env.COTAL_DEFAULT_AGENT = "manager-default";
  try {
    const caller = await mgr.startAgent({ name: "plain", defaultAgent: "caller-default", events: false });
    check("detached caller default beats the manager environment default", (caller.data as { agent?: string })?.agent === "caller-default", caller);
    const pinned = await mgr.startAgent({ name: "pinned", defaultAgent: "caller-default", events: false });
    check("persona pin beats the detached caller default", (pinned.data as { agent?: string })?.agent === "smoke-ov", pinned);
    const explicit = await mgr.startAgent({ name: "plain", agent: "manager-default", defaultAgent: "caller-default", events: false });
    check("explicit agent beats the detached caller default", (explicit.data as { agent?: string })?.agent === "manager-default", explicit);
  } finally {
    if (prev === undefined) delete process.env.COTAL_DEFAULT_AGENT;
    else process.env.COTAL_DEFAULT_AGENT = prev;
  }
}

// 11: a persona file in a project folder that is not trusted contributes no launch options on the
// manager path: the spawn is refused before any launch, naming the file, the key and `cotal trust`.
// The same persona in a trusted folder launches with them, and the caller's own options still apply.
{
  const untrusted = mkdtempSync(join(tmpdir(), "cotal-start-ov-untrusted-"));
  mkdirSync(join(untrusted, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(untrusted, ".cotal", "agents", "opts.md"), "---\nname: opts\nlaunchOptions:\n  mcp-config: /tmp/planted.json\n---\n");
  writeFileSync(join(untrusted, ".cotal", "agents", "bare.md"), "---\nname: bare\n---\n");
  const mgr2 = new Manager({ space: "smoke", servers: undefined, runtime: "pty", workspaceRoot: untrusted });
  // Its own fake runtime and roster, the same shape as the first manager's, so a launch resolves.
  (mgr2 as unknown as { runtime: object }).runtime = (mgr as unknown as { runtime: object }).runtime;
  (mgr2 as unknown as { ep: object }).ep = {
    ...(mgr as unknown as { ep: object }).ep,
    getRoster: () => [...(mgr2 as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid })),
  };
  resetOpts();
  const refused = await mgr2.startAgent({ name: "opts", agent: "smoke-ov", events: false });
  check("an untrusted project's persona launch options refuse the manager spawn", !refused.ok && lastOpts === undefined && /launchOptions\.mcp-config/.test(String(refused.error)) && String(refused.error).includes(`cotal trust ${untrusted}`), refused);
  resetOpts();
  const callerOpts = await mgr2.startAgent({ name: "bare", agent: "smoke-ov", events: false, launchOptions: { "mcp-config": "/tmp/caller.json" } });
  check("the caller's own launch options are not gated on the manager path", callerOpts.ok && lastOpts?.launchOptions?.["mcp-config"] === "/tmp/caller.json", j(callerOpts));
  trustProject(untrusted);
  resetOpts();
  const allowed = await mgr2.startAgent({ name: "opts", agent: "smoke-ov", events: false });
  check("a trusted project's persona launch options reach the connector on the manager path", allowed.ok && lastOpts?.launchOptions?.["mcp-config"] === "/tmp/planted.json", j(allowed));
}

// A manifest launch carries the persona's launch options merged into its spec, so the manager reads
// the persona file it names again: in a folder that is not trusted, a key that file declares refuses,
// both for a spec pushed inline (before the spec is kept) and for one already on disk. The
// manifest's own launch options, with a persona that declares none, are not gated.
{
  const manifestRoot = mkdtempSync(join(tmpdir(), "cotal-start-ov-manifest-"));
  mkdirSync(join(manifestRoot, ".cotal", "agents", "team"), { recursive: true });
  const personaPath = join(manifestRoot, ".cotal", "agents", "team", "opts.md");
  writeFileSync(personaPath, "---\nname: opts\nlaunchOptions:\n  mcp-config: /tmp/planted.json\n---\n");
  const barePath = join(manifestRoot, ".cotal", "agents", "bare.md");
  writeFileSync(barePath, "---\nname: bare\n---\n");
  const mgr3 = new Manager({ space: "smoke", servers: undefined, runtime: "pty", workspaceRoot: manifestRoot });
  (mgr3 as unknown as { runtime: object }).runtime = (mgr as unknown as { runtime: object }).runtime;
  (mgr3 as unknown as { ep: object }).ep = {
    ...(mgr as unknown as { ep: object }).ep,
    getRoster: () => [...(mgr3 as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid })),
  };
  const agentOf = (name: string, persona: string, launchOptions: Record<string, unknown>): MeshLaunchAgent => ({
    name, agent: "smoke-ov", role: "worker", body: "body", events: false, launchOptions,
    subscribe: [], allowSubscribe: [], allowPublish: [], personaPath: persona, hash: `h${name}`,
  });
  const launch = (runId: string, a: MeshLaunchAgent) => (mgr3 as unknown as { opLaunch(a: Record<string, unknown>, c: string, admin: boolean): Promise<{ ok: boolean; error?: string }> })
    .opLaunch({ runId, name: a.name, spec: { apiVersion: "cotal-launch/v1", space: "smoke", runId, agents: [a] } }, "smoke-caller", true);

  resetOpts();
  const inline = await launch("runinline01", agentOf("nested", personaPath, { "mcp-config": "/tmp/planted.json" }));
  check("an inline manifest spec carrying an untrusted persona's launch options is refused and not kept",
    !inline.ok && lastOpts === undefined && /launchOptions\.mcp-config/.test(String(inline.error)) && String(inline.error).includes(`cotal trust ${manifestRoot}`)
      && !existsSync(join(manifestRoot, ".cotal", "run", "runinline01.json")), j(inline));
  resetOpts();
  const resolvedStart = await mgr3.startAgent({ name: "nested2", agent: "smoke-ov", events: false, config: personaPath, resolved: agentOf("nested2", personaPath, { "mcp-config": "/tmp/planted.json" }) });
  check("a manifest start from a spec on disk with an untrusted persona's launch options is refused", !resolvedStart.ok && lastOpts === undefined && /launchOptions\.mcp-config/.test(String(resolvedStart.error)), j(resolvedStart));
  resetOpts();
  const own = await launch("runinline02", agentOf("ownopts", barePath, { "mcp-config": "/tmp/manifest.json" }));
  check("a manifest's own launch options, with a persona that declares none, are not gated", own.ok && lastOpts?.launchOptions?.["mcp-config"] === "/tmp/manifest.json", j(own));
  trustProject(manifestRoot);
  resetOpts();
  const trusted = await launch("runinline03", agentOf("nested3", personaPath, { "mcp-config": "/tmp/planted.json" }));
  check("CONTROL: the same inline spec launches once the folder is trusted", trusted.ok && lastOpts?.launchOptions?.["mcp-config"] === "/tmp/planted.json", j(trusted));

  // The manager judges a manifest persona path as written and as read: a link outside any
  // `.cotal/agents`, or in the trusted project's own `.cotal/agents`, naming a persona under an
  // untrusted project refuses on both manager routes; a link within the trusted project launches.
  const other = mkdtempSync(join(tmpdir(), "cotal-start-ov-linked-"));
  mkdirSync(join(other, ".cotal", "agents"), { recursive: true });
  const otherPersona = join(other, ".cotal", "agents", "opts.md");
  writeFileSync(otherPersona, "---\nname: opts\nlaunchOptions:\n  mcp-config: /tmp/linked.json\n---\n");
  const outsideDir = mkdtempSync(join(tmpdir(), "cotal-start-ov-outside-"));
  const linkOut = join(outsideDir, "link.md");
  symlinkSync(otherPersona, linkOut);
  const linkIn = join(manifestRoot, ".cotal", "agents", "link.md");
  symlinkSync(otherPersona, linkIn);
  const linkSame = join(manifestRoot, ".cotal", "agents", "same.md");
  symlinkSync(personaPath, linkSame);
  const linked = { "mcp-config": "/tmp/linked.json" };
  resetOpts();
  const outInline = await launch("runlink01", agentOf("linkout", linkOut, linked));
  resetOpts();
  const outResolved = await mgr3.startAgent({ name: "linkout2", agent: "smoke-ov", events: false, config: linkOut, resolved: agentOf("linkout2", linkOut, linked) });
  check("a manifest persona linked from outside .cotal/agents to an untrusted project refuses inline and from disk",
    !outInline.ok && !outResolved.ok && lastOpts === undefined && String(outInline.error).includes(`cotal trust ${other}`) && String(outResolved.error).includes(`cotal trust ${other}`)
      && !existsSync(join(manifestRoot, ".cotal", "run", "runlink01.json")), { inline: j(outInline), resolved: j(outResolved) });
  resetOpts();
  const inInline = await launch("runlink02", agentOf("linkin", linkIn, linked));
  resetOpts();
  const inResolved = await mgr3.startAgent({ name: "linkin2", agent: "smoke-ov", events: false, config: linkIn, resolved: agentOf("linkin2", linkIn, linked) });
  check("a manifest persona linked from a trusted project's .cotal/agents to an untrusted project refuses inline and from disk",
    !inInline.ok && !inResolved.ok && lastOpts === undefined && String(inInline.error).includes(`cotal trust ${other}`) && String(inResolved.error).includes(`cotal trust ${other}`)
      && !existsSync(join(manifestRoot, ".cotal", "run", "runlink02.json")), { inline: j(inInline), resolved: j(inResolved) });
  resetOpts();
  const sameLink = await launch("runlink03", agentOf("linksame", linkSame, { "mcp-config": "/tmp/planted.json" }));
  check("CONTROL: a manifest persona linked within the trusted project launches", sameLink.ok && lastOpts?.launchOptions?.["mcp-config"] === "/tmp/planted.json", j(sameLink));
}

console.log(failures ? `\nSTART-OVERRIDES SMOKE FAILED ❌ (${failures} failed)` : "\nstart-overrides smoke: all checks passed");
process.exit(failures ? 1 : 0);
