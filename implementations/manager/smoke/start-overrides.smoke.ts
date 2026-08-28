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
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  await mgr.startAgent({ name: "team", agent: "smoke-ov" });
  check("no override → file subscribe", j(lastOpts?.subscribe) === j(["team"]), lastOpts?.subscribe);
  check("no override → file allowPublish", j(lastOpts?.allowPublish) === j(["team"]), lastOpts?.allowPublish);
}

// 3 — allowSubscribe defaults from the OVERRIDDEN subscribe (one source feeds creds + connector).
{
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", subscribe: ["ops"] });
  check("allowSubscribe defaults from overridden subscribe", j(lastOpts?.allowSubscribe) === j(["ops"]), lastOpts?.allowSubscribe);
}

// 4 — prompt threads verbatim.
{
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", prompt: "hello team" });
  check("prompt threads into LaunchOpts.prompt", lastOpts?.prompt === "hello team", lastOpts?.prompt);
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov" });
  check("no --prompt → LaunchOpts.prompt undefined", lastOpts?.prompt === undefined, lastOpts?.prompt);
}

// 5 — share-tools selection narrows the declared servers; `none` = none; absent = all; unknown fails.
{
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov" });
  check("absent shareTools → all declared servers", j(Object.keys(lastOpts?.mcpServers ?? {})) === j(["alpha", "beta"]), lastOpts?.mcpServers);
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: "alpha" });
  check("named selection → that server only", j(Object.keys(lastOpts?.mcpServers ?? {})) === j(["alpha"]), lastOpts?.mcpServers);
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: "none" });
  check("shareTools none → no servers", j(Object.keys(lastOpts?.mcpServers ?? {})) === j([]), lastOpts?.mcpServers);
  const bad = await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: "gamma" });
  check("undeclared share-tools name fails loud", bad.ok === false && /gamma/.test(bad.error ?? ""), bad);
}

// 6 — the identity override (`--name` alongside a ref) wins over the file's `name:` and threads
// into both the reply and LaunchOpts (foreground's `requested = values.name ?? def.name` parity).
{
  resetOpts();
  const r = await mgr.startAgent({ name: "team", agent: "smoke-ov", identity: "scout" });
  check("identity override spawns", r.ok === true, r);
  check("identity override wins over file name:", (r.data as { name?: string })?.name === "scout", r.data);
  check("identity threads into LaunchOpts.name", lastOpts?.name === "scout", lastOpts?.name);
  resetOpts();
  await mgr.startAgent({ name: "plain", agent: "smoke-ov" });
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
  const r1 = await mgr.startAgent({ name: "mfst", agent: "smoke-ov", config: cfg, resolved, prompt: "x" });
  check("resolved + prompt rejected", r1.ok === false && /rejects imperative overrides/.test(r1.error ?? ""), r1);
  const r2 = await mgr.startAgent({ name: "mfst", agent: "smoke-ov", config: cfg, resolved, subscribe: ["x"] });
  check("resolved + subscribe rejected", r2.ok === false && /rejects imperative overrides/.test(r2.error ?? ""), r2);
  const r3 = await mgr.startAgent({ name: "mfst", agent: "smoke-ov", config: cfg, resolved, identity: "x" });
  check("resolved + identity rejected", r3.ok === false && /rejects imperative overrides/.test(r3.error ?? ""), r3);
}

// 8 — COTAL_DEFAULT_AGENT supplies the manager-side default harness.
{
  const prev = process.env.COTAL_DEFAULT_AGENT;
  process.env.COTAL_DEFAULT_AGENT = "smoke-ov";
  try {
    resetOpts();
    const r = await mgr.startAgent({ name: "plain" });
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
    const r = await mgr.startAgent({ name: "pinned" }); // no --agent, env points elsewhere
    check("file pin spawn succeeds", r.ok === true, r);
    check("persona agent: pin picks the harness (file beats env)", (r.data as { agent?: string })?.agent === "smoke-ov", r.data);
    check("the pinned connector built the launch", lastOpts !== undefined && /^pinned(-\d+)?$/.test(lastOpts.name ?? ""), lastOpts?.name);
    resetOpts();
    const f = await mgr.startAgent({ name: "pinned", agent: "smoke-other" }); // explicit flag wins
    check("flag spawn succeeds", f.ok === true, f);
    check("explicit --agent wins over the file pin", (f.data as { agent?: string })?.agent === "smoke-other", f.data);
  } finally {
    if (prev === undefined) delete process.env.COTAL_DEFAULT_AGENT;
    else process.env.COTAL_DEFAULT_AGENT = prev;
  }
  // The loud guard: a pin naming an unregistered connector fails the spawn (no silent default).
  writeFileSync(join(agentsDir, "typo.md"), "---\nname: typo\nagent: no-such-connector\nsubscribe: []\n---\nx\n");
  const t = await mgr.startAgent({ name: "typo" });
  check("a pin naming an unregistered connector fails loud", t.ok === false && /no-such-connector/.test(t.error ?? ""), t);
  // An UNPINNED persona with an explicit flag is unaffected by any of the above (pin must not leak).
  delete process.env.COTAL_DEFAULT_AGENT;
  const d = await mgr.startAgent({ name: "plain", agent: "smoke-other" });
  check("unpinned persona still honors the flag", (d.data as { agent?: string })?.agent === "smoke-other", d.data);
}

// 10 — a detached caller's environment default is a distinct precedence layer. It must survive
// dispatch when the manager's environment differs, without becoming an explicit override that can
// beat the persona file.
{
  const prev = process.env.COTAL_DEFAULT_AGENT;
  process.env.COTAL_DEFAULT_AGENT = "manager-default";
  try {
    const caller = await mgr.startAgent({ name: "plain", defaultAgent: "caller-default" });
    check("detached caller default beats the manager environment default", (caller.data as { agent?: string })?.agent === "caller-default", caller);
    const pinned = await mgr.startAgent({ name: "pinned", defaultAgent: "caller-default" });
    check("persona pin beats the detached caller default", (pinned.data as { agent?: string })?.agent === "smoke-ov", pinned);
    const explicit = await mgr.startAgent({ name: "plain", agent: "manager-default", defaultAgent: "caller-default" });
    check("explicit agent beats the detached caller default", (explicit.data as { agent?: string })?.agent === "manager-default", explicit);
  } finally {
    if (prev === undefined) delete process.env.COTAL_DEFAULT_AGENT;
    else process.env.COTAL_DEFAULT_AGENT = prev;
  }
}

console.log(failures ? `\nSTART-OVERRIDES SMOKE FAILED ❌ (${failures} failed)` : "\nstart-overrides smoke: all checks passed");
process.exit(failures ? 1 : 0);
