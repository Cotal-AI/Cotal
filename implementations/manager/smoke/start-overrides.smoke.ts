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
 * Run: pnpm smoke:start-overrides
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
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
  getRoster: () => [...(mgr as unknown as { agents: Map<string, { id: string; name: string }> }).agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle" })),
};

let lastOpts: LaunchOpts | undefined;
const recCon: Connector = {
  kind: "connector",
  name: "smoke-ov",
  requires: ["node"],
  buildLaunch: (o) => { lastOpts = o; return { command: "true", args: [], env: {} }; },
};
registry.register(recCon);

const j = (v: unknown) => JSON.stringify(v);

// 1 — ACL overrides win over the persona file (flags > file, foreground-parity precedence).
{
  lastOpts = undefined;
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
  lastOpts = undefined;
  await mgr.startAgent({ name: "team", agent: "smoke-ov" });
  check("no override → file subscribe", j(lastOpts?.subscribe) === j(["team"]), lastOpts?.subscribe);
  check("no override → file allowPublish", j(lastOpts?.allowPublish) === j(["team"]), lastOpts?.allowPublish);
}

// 3 — allowSubscribe defaults from the OVERRIDDEN subscribe (one source feeds creds + connector).
{
  lastOpts = undefined;
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", subscribe: ["ops"] });
  check("allowSubscribe defaults from overridden subscribe", j(lastOpts?.allowSubscribe) === j(["ops"]), lastOpts?.allowSubscribe);
}

// 4 — prompt threads verbatim.
{
  lastOpts = undefined;
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", prompt: "hello team" });
  check("prompt threads into LaunchOpts.prompt", lastOpts?.prompt === "hello team", lastOpts?.prompt);
  lastOpts = undefined;
  await mgr.startAgent({ name: "plain", agent: "smoke-ov" });
  check("no --prompt → LaunchOpts.prompt undefined", lastOpts?.prompt === undefined, lastOpts?.prompt);
}

// 5 — share-tools selection narrows the declared servers; `none` = none; absent = all; unknown fails.
{
  lastOpts = undefined;
  await mgr.startAgent({ name: "plain", agent: "smoke-ov" });
  check("absent shareTools → all declared servers", j(Object.keys(lastOpts?.mcpServers ?? {})) === j(["alpha", "beta"]), lastOpts?.mcpServers);
  lastOpts = undefined;
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: "alpha" });
  check("named selection → that server only", j(Object.keys(lastOpts?.mcpServers ?? {})) === j(["alpha"]), lastOpts?.mcpServers);
  lastOpts = undefined;
  await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: "none" });
  check("shareTools none → no servers", j(Object.keys(lastOpts?.mcpServers ?? {})) === j([]), lastOpts?.mcpServers);
  const bad = await mgr.startAgent({ name: "plain", agent: "smoke-ov", shareTools: "gamma" });
  check("undeclared share-tools name fails loud", bad.ok === false && /gamma/.test(bad.error ?? ""), bad);
}

// 6 — the identity override (`--name` alongside a ref) wins over the file's `name:` and threads
// into both the reply and LaunchOpts (foreground's `requested = values.name ?? def.name` parity).
{
  lastOpts = undefined;
  const r = await mgr.startAgent({ name: "team", agent: "smoke-ov", identity: "scout" });
  check("identity override spawns", r.ok === true, r);
  check("identity override wins over file name:", (r.data as { name?: string })?.name === "scout", r.data);
  check("identity threads into LaunchOpts.name", lastOpts?.name === "scout", lastOpts?.name);
  lastOpts = undefined;
  await mgr.startAgent({ name: "plain", agent: "smoke-ov" });
  // Earlier sections spawned `plain` repeatedly — uniqueName auto-numbers, so match the series.
  check("no identity override → file name: (auto-numbered)", /^plain(-\d+)?$/.test(lastOpts?.name ?? ""), lastOpts?.name);
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
    lastOpts = undefined;
    const r = await mgr.startAgent({ name: "plain" });
    check("COTAL_DEFAULT_AGENT spawn succeeds", r.ok === true, r);
    check("COTAL_DEFAULT_AGENT used as manager default", (r.data as { agent?: string })?.agent === "smoke-ov", r.data);
    check("env default reaches LaunchOpts", lastOpts?.space === "smoke" && /^plain(-\d+)?$/.test(lastOpts?.name ?? ""), lastOpts);
  } finally {
    if (prev === undefined) delete process.env.COTAL_DEFAULT_AGENT;
    else process.env.COTAL_DEFAULT_AGENT = prev;
  }
}

console.log(failures ? `\nSTART-OVERRIDES SMOKE FAILED ❌ (${failures} failed)` : "\nstart-overrides smoke: all checks passed");
process.exit(failures ? 1 : 0);
