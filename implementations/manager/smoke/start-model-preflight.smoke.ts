/**
 * Start model-override + harness-preflight smoke — proves the two manager fixes end to end without
 * a broker or a real harness launch. No NATS, no test runner — run with: pnpm smoke:start-model
 *
 * The Manager constructor opens no network (that happens in start()), so we drive the real
 * `startAgent` spawn path directly, injecting a fake runtime + a minimal `ep` stub so the
 * success branch never launches a child or needs a live mesh. Covers:
 *   1. Preflight REJECT — a connector whose `requires` binary is off PATH fails before any
 *      credential/side effect, with a stable, PATH-content-independent error.
 *   2. Model THREADING — `--model` rides StartAgentOpts → buildLaunch's LaunchOpts verbatim.
 *   3. Model PRECEDENCE — across the three real connectors: flag > agent-file `model:`, the flag
 *      applies with no agent file, and the file is the fallback (the actual bug the fix closes).
 *   4. ACL THREADING — the resolved read/post set rides StartAgentOpts → LaunchOpts and each
 *      connector forwards it as COTAL_SUBSCRIBE / COTAL_ALLOW_*. Guards the bug where creds were
 *      minted from the policy but it never reached the connector, so a manifest-spawned agent (whose
 *      materialized persona has no access frontmatter) fell back to ["general"] and joined nothing.
 *   5. RESUME (issue #23) — claude buildLaunch emits `--resume <id> --fork-session` (never one
 *      without the other, hostile id stays one argv token, coexists with the persona append);
 *      opencode + hermes THROW; and `resume` threads StartAgentOpts → LaunchOpts verbatim.
 *   6. RESUME CAPABILITY PREFLIGHT (issue #159 Part A) — a resume request for a connector that doesn't
 *      declare `supportsResume` is rejected BEFORE any provisioning side effect (no mint, no
 *      buildLaunch), mirroring the harness preflight; `supportsResume` matrix across the connectors.
 *   7. LAUNCH-FAILURE SURFACING (issue #159 Part B1) — the readiness race reports a detached spawn that
 *      dies on arrival (an already-exited handle, the shape a bad `--resume` id produces) as a FAILURE with
 *      the child's last output as the cause, and records no live agent — never a false `✓ started`.
 *   8. MISSED-EXIT REAP (issue #159 B1, review hardening) — an agent that joins presence (→ started) then
 *      dies just as watchExit subscribes (onExit never fires for a late subscriber) is still reaped:
 *      watchExit re-checks status() right after subscribing and removes the leaked agent.
 *   9. SHUTDOWN TEARDOWN (issue #159 B2, review blocker) — Manager.stop() reaps EVERY managed agent (hard-
 *      stops the child + clears the map), not just the lease/endpoints, so a manager shutdown doesn't
 *      orphan their footprints. (The broker-side deprovision is a no-op in open mode — proven under auth in
 *      deprovision-agent-auth.smoke — so this covers the stop() wiring.)
 *  10. LEASE-LOSS TEARDOWN (issue #159 B2, review re-check) — the fail-closed lease-loss exit reaps agents
 *      through the SAME shared teardownManagedAgents() helper as stop(), so it can't exit leaving footprints.
 *  11. BEST-EFFORT STOP ON REAP (issue #159 B2, review round 5) — stopHandle() (the single stop chokepoint)
 *      never throws, so a throwing runtime hard-stop on despawn/self-stop/reap can't abort the freeSlot that
 *      follows; reapChildrenOf continues over every sibling even when one child's stop throws.
 *  12. UNCERTAIN READINESS (issue #159 B1, review design) — when neither presence nor exit is observed
 *      within the backstop, the launch is reported UNCERTAIN: a non-success reply that KEEPS the agent (no
 *      deprovision — it may still be booting), distinct from both started and failed.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { Manager } from "../src/manager.js";
import { principalKey, registry, DEV_OWNER, type Connector, type LaunchOpts, type LaunchSpec, type AgentHandle } from "@cotal-ai/core";
// Import the real connectors so they self-register (and expose their objects for the buildLaunch matrix).
import { claudeConnector } from "@cotal-ai/connector-claude-code";
import { opencodeConnector } from "@cotal-ai/connector-opencode";
import { hermesConnector } from "@cotal-ai/connector-hermes";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

// Hermes is Unix-only — its buildLaunch THROWS on win32 by design (AF_UNIX bridge + Python sidecar).
// This smoke is CI-gated on both OSes (`pnpm test`), so on Windows we skip the Hermes buildLaunch rows
// (claude + opencode still run) and instead assert the Unix-only guard fires. `connectors` is the set
// whose buildLaunch is exercised per-platform.
const onWin = process.platform === "win32";
const connectors = onWin ? [claudeConnector, opencodeConnector] : [claudeConnector, opencodeConnector, hermesConnector];

// A workspace with no cotal *config*. A manager spawn now REQUIRES a discoverable persona (no
// silent default-ACL fallback), so seed a minimal `.cotal/agents/<name>.md` per spawned name —
// this test's subject is harness preflight + model threading, not persona/ACL resolution.
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-start-ws-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
for (const n of ["reject1", "rec1", "rec2", "rrec1", "rrec2", "norsm1", "norsm2", "dead1", "missed1", "shut1", "shut2", "lease1", "lease2", "unc1"]) writeFileSync(join(agentsDir, `${n}.md`), `---\nname: ${n}\n---\n`);
// rec3 carries an explicit access policy — its frontmatter ACL must thread through to LaunchOpts.
writeFileSync(join(agentsDir, "rec3.md"), `---\nname: rec3\nsubscribe: [team]\nallowSubscribe: [team, team.>]\nallowPublish: [team]\n---\n`);
const mgr = new Manager({ space: "smoke", servers: undefined, runtime: "pty", workspaceRoot });

// Inert handle/runtime: the success branch records the built spec but launches nothing; the `ep`
// stub only needs ref().id for the managed record. watchExit() calls attach().onExit — a no-op here.
const fakeSession = {
  cols: 80, rows: 24, backlog: () => Buffer.alloc(0),
  onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {},
};
const fakeHandle = (name: string): AgentHandle => ({
  name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession,
});
let lastSpec: LaunchSpec | undefined;
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
  kind: "fake",
  spawn: (name, spec) => { lastSpec = spec; return fakeHandle(name); },
};
const agentsMap = () => (mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents;
// Fake `ep` for the #159 B1 readiness race: getRoster() reports every currently-managed agent as LIVE, so
// a just-spawned agent (already in `agents` when awaitReadiness runs) resolves "started" via the subscribe-
// then-check — no timer wait. The "presence" event is only a wake, so on/off are no-ops. A custom `roster`
// overrides the reported set (the UNCERTAIN test reports nobody). `extra` adds ep methods stop() needs.
const fakeEp = (extra: Record<string, unknown> = {}, roster?: () => Array<{ card: { id: string; name: string }; status: string }>) => ({
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  getRoster: roster ?? (() => [...agentsMap().values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid }))),
  ...extra,
});
(mgr as unknown as { ep: unknown }).ep = fakeEp();
const agentCount = () => agentsMap().size;

// A recording connector that requires `node` (present whenever this smoke runs) — captures the
// LaunchOpts the manager hands it, so we can assert the model threads through verbatim. Declares
// `supportsResume` so a resume request passes the pre-mint preflight and reaches buildLaunch.
// The connector callback below is what assigns this, and the checker cannot follow a call into
// a registered extension. A bare `x = undefined` reset therefore narrows the binding to
// `undefined` for the rest of the block and every later read reports on `never`, so the reset
// goes through a call, which leaves the declared type in place. Runtime behaviour is identical.
let lastOpts: LaunchOpts | undefined;
const resetOpts = () => { lastOpts = undefined; };
const recCon: Connector = {
  kind: "connector",
  name: "smoke-rec",
  requires: ["node"],
  supportsResume: true,
  buildLaunch: (o) => { lastOpts = o; return { command: "true", args: [], env: {} }; },
};
registry.register(recCon);

// A twin that passes the harness preflight (node present) but does NOT support resume — used to prove
// the pre-mint resume preflight rejects BEFORE reaching buildLaunch (its buildLaunch must never run).
// Only buildLaunch below assigns this, and the checker cannot follow a call into a registered
// connector. An initialised flag reset with a bare assignment narrows to that literal, so a later
// `=== true` reads as a comparison that cannot hold. Declared unset and reset through a call, the
// binding keeps its declared type and the cells state the same claims.
let noResumeBuilt: boolean | undefined;
const resetNoResumeBuilt = () => { noResumeBuilt = undefined; };
const recNoResumeCon: Connector = {
  kind: "connector",
  name: "smoke-norsm",
  requires: ["node"],
  buildLaunch: (o) => { noResumeBuilt = true; lastOpts = o; return { command: "true", args: [], env: {} }; },
};
registry.register(recNoResumeCon);

// 1 — Preflight REJECT: hide PATH so `claude` can't be found; the real claude connector requires it.
{
  const savedPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "cotal-empty-path-")); // a dir with no executables
  const reply = await mgr.startAgent({ name: "reject1", agent: "claude" });
  process.env.PATH = savedPath;
  check("missing harness binary is rejected", reply.ok === false, reply);
  check(
    "reject error names the missing binary, no PATH contents",
    reply.error === "claude harness needs claude on PATH - not found",
    reply.error,
  );
  check("reject happens before any side effect (no agent recorded)", agentCount() === 0);
}

// 2 — Model THREADING through the manager into LaunchOpts (PATH restored → `node` present again).
{
  resetOpts();
  const reply = await mgr.startAgent({ name: "rec1", agent: "smoke-rec", model: "sonnet" });
  check("present-binary connector passes preflight + spawns", reply.ok === true, reply);
  check("--model threads into LaunchOpts.model verbatim", lastOpts?.model === "sonnet", lastOpts?.model);
  check("built spec was captured (success path ran)", lastSpec?.command === "true");

  resetOpts();
  await mgr.startAgent({ name: "rec2", agent: "smoke-rec" });
  check("no --model → LaunchOpts.model undefined", lastOpts?.model === undefined, lastOpts?.model);

  // ACL threading: the resolved read/post set must reach the connector via LaunchOpts (the bug —
  // it was minted into creds but never handed to buildLaunch, so the connector fell back to general).
  resetOpts();
  await mgr.startAgent({ name: "rec3", agent: "smoke-rec" });
  check("persona subscribe threads into LaunchOpts.subscribe", JSON.stringify(lastOpts?.subscribe) === '["team"]', lastOpts?.subscribe);
  check("persona allowSubscribe threads into LaunchOpts", JSON.stringify(lastOpts?.allowSubscribe) === '["team","team.>"]', lastOpts?.allowSubscribe);
  check("persona allowPublish threads into LaunchOpts", JSON.stringify(lastOpts?.allowPublish) === '["team"]', lastOpts?.allowPublish);
}

// 3 — Model PRECEDENCE across the three real connectors (direct buildLaunch; no PATH/broker need).
{
  const dir = mkdtempSync(join(tmpdir(), "cotal-start-af-"));
  const af = join(dir, "tester.md");
  writeFileSync(af, "---\nname: tester\nmodel: opus\n---\nbody persona\n");
  const base = { space: "smoke", name: "tester" };
  const claudeModel = (s: LaunchSpec) => { const i = s.args.indexOf("--model"); return i >= 0 ? s.args[i + 1] : undefined; };
  const ocModel = (s: LaunchSpec) => JSON.parse(s.env!.OPENCODE_CONFIG_CONTENT).model as string | undefined;
  const hermesModel = (s: LaunchSpec) => s.env!.HERMES_MODEL;

  check("claude.requires == [claude]", JSON.stringify(claudeConnector.requires) === '["claude"]');
  check("opencode.requires == [opencode]", JSON.stringify(opencodeConnector.requires) === '["opencode"]');
  check("hermes.requires == [hermes]", JSON.stringify(hermesConnector.requires) === '["hermes"]');

  // Hermes is Unix-only: on win32 buildLaunch throws BEFORE producing a spec — assert that guard here
  // and skip the Hermes model rows below (they'd all throw). claude + opencode still run on both OSes.
  if (onWin) {
    let threw = false;
    try { hermesConnector.buildLaunch({ ...base }); } catch { threw = true; }
    check("hermes: buildLaunch throws (Unix-only) on win32", threw);
  }

  // flag wins over the agent file's `model:`
  check("claude: flag beats frontmatter", claudeModel(claudeConnector.buildLaunch({ ...base, configPath: af, model: "sonnet" })) === "sonnet");
  check("opencode: flag beats frontmatter", ocModel(opencodeConnector.buildLaunch({ ...base, configPath: af, model: "sonnet" })) === "sonnet");
  if (!onWin) check("hermes: flag beats frontmatter", hermesModel(hermesConnector.buildLaunch({ ...base, configPath: af, model: "sonnet" })) === "sonnet");

  // flag applies with NO agent file (the gap the fix closes)
  check("claude: flag with no agent file", claudeModel(claudeConnector.buildLaunch({ ...base, model: "sonnet" })) === "sonnet");
  check("opencode: flag with no agent file", ocModel(opencodeConnector.buildLaunch({ ...base, model: "sonnet" })) === "sonnet");
  if (!onWin) check("hermes: flag with no agent file", hermesModel(hermesConnector.buildLaunch({ ...base, model: "sonnet" })) === "sonnet");

  // no flag → agent-file model is the fallback (incl. Hermes, whose launcher previously ignored it)
  check("claude: no flag → frontmatter opus", claudeModel(claudeConnector.buildLaunch({ ...base, configPath: af })) === "opus");
  check("opencode: no flag → frontmatter opus", ocModel(opencodeConnector.buildLaunch({ ...base, configPath: af })) === "opus");
  if (!onWin) check("hermes: no flag → frontmatter opus", hermesModel(hermesConnector.buildLaunch({ ...base, configPath: af })) === "opus");

  // nothing set → no model applied
  check("claude: nothing → no --model", claudeModel(claudeConnector.buildLaunch({ ...base })) === undefined);
  check("opencode: nothing → no config.model", ocModel(opencodeConnector.buildLaunch({ ...base })) === undefined);
  if (!onWin) check("hermes: nothing → no HERMES_MODEL", hermesModel(hermesConnector.buildLaunch({ ...base })) === undefined);

  // 4 — ACL ENV emission: each connector forwards the resolved policy so the spawned session's
  // runtime read/post set matches its minted creds. Wildcard allowSubscribe (team.>) must survive.
  const acl = { subscribe: ["team"], allowSubscribe: ["team", "team.>"], allowPublish: ["team"] };
  for (const con of connectors) {
    const env = con.buildLaunch({ ...base, ...acl }).env!;
    check(`${con.name}: COTAL_SUBSCRIBE forwarded`, env.COTAL_SUBSCRIBE === "team", env.COTAL_SUBSCRIBE);
    check(`${con.name}: COTAL_ALLOW_SUBSCRIBE forwarded (wildcard kept)`, env.COTAL_ALLOW_SUBSCRIBE === "team,team.>", env.COTAL_ALLOW_SUBSCRIBE);
    check(`${con.name}: COTAL_ALLOW_PUBLISH forwarded`, env.COTAL_ALLOW_PUBLISH === "team", env.COTAL_ALLOW_PUBLISH);
    // No policy → no env (persona-spawn / no-channel path unchanged: connector reads the file or
    // falls back to the general baseline — never silently overridden to empty).
    check(`${con.name}: no policy → COTAL_SUBSCRIBE absent`, con.buildLaunch({ ...base }).env!.COTAL_SUBSCRIBE === undefined);
  }
}

// 5 — RESUME: fork an existing session into the mesh (issue #23). claude renders
// `--resume <id> --fork-session`; opencode + hermes THROW (no silent fresh-spawn fallback); the id
// threads through the manager verbatim and stays a single argv token (no shell). The manifest path
// carries no resume by construction (see the cotal.yaml reject in cli manifest.smoke.ts).
{
  const base = { space: "smoke", name: "tester" };
  const cArgs = (o: LaunchOpts) => claudeConnector.buildLaunch(o).args;

  // claude, resume SET → BOTH --resume <id> and --fork-session, id is the token right after --resume.
  {
    const a = cArgs({ ...base, resume: "sess-123" });
    const ri = a.indexOf("--resume");
    check("claude: --resume emitted when resume set", ri >= 0, a);
    check("claude: id is the single token after --resume", a[ri + 1] === "sess-123", a[ri + 1]);
    check("claude: --fork-session emitted when resume set", a.includes("--fork-session"), a);
  }
  // claude, resume UNSET → neither flag.
  {
    const a = cArgs({ ...base });
    check("claude: no --resume when unset", !a.includes("--resume"), a);
    check("claude: no --fork-session when unset", !a.includes("--fork-session"), a);
  }
  // INVARIANT — claude NEVER emits --resume without --fork-session (argv-level hijack guard).
  {
    const a = cArgs({ ...base, resume: "x" });
    check("claude: --resume never without --fork-session", !a.includes("--resume") || a.includes("--fork-session"), a);
  }
  // A hostile-looking id stays ONE argv element — args is an array, so no shell/interpolation/split.
  {
    const weird = "abc def;$(nope) `id` && rm -rf /";
    const a = cArgs({ ...base, resume: weird });
    check("claude: hostile id stays one argv element", a[a.indexOf("--resume") + 1] === weird, a[a.indexOf("--resume") + 1]);
  }
  // resume + persona: the forked context runs under the CURRENT mesh persona (both flags coexist).
  {
    const dir = mkdtempSync(join(tmpdir(), "cotal-resume-af-"));
    const af = join(dir, "p.md");
    writeFileSync(af, "---\nname: p\n---\nMESH PERSONA BODY\n");
    const a = cArgs({ ...base, configPath: af, resume: "sess-9" });
    check("claude: resume + persona → --append-system-prompt kept", a.includes("--append-system-prompt"), a);
    check("claude: resume + persona → --resume kept", a.includes("--resume"), a);
    check("claude: resume + persona → --fork-session kept", a.includes("--fork-session"), a);
  }
  // prompt + resume: the ONE combo that only foreground spawn can produce (the recommended primary
  // surface). The leading positional prompt AND the resume/fork pair must coexist — auto-submit into
  // the forked session, not a special resume-only launch shape.
  {
    const a = cArgs({ ...base, prompt: "hello mesh", resume: "sess-p" });
    check("claude: prompt+resume → prompt is the leading positional", a[0] === "hello mesh", a[0]);
    check("claude: prompt+resume → --resume still emitted", a.includes("--resume"), a);
    check("claude: prompt+resume → --fork-session still emitted", a.includes("--fork-session"), a);
  }
  // Exact-session continuation is Pi-only. Every other connector throws instead of silently fresh-launching.
  const noContinue = onWin ? [claudeConnector, opencodeConnector] : [claudeConnector, opencodeConnector, hermesConnector];
  for (const con of noContinue) {
    let threw = false;
    try { con.buildLaunch({ ...base, continueSession: "current" }); } catch { threw = true; }
    check(`${con.name}: buildLaunch({continueSession}) throws`, threw);
  }
  let codexContinueThrew = false;
  try { (await import("@cotal-ai/connector-codex")).codexConnector.buildLaunch({ ...base, continueSession: "current" }); } catch { codexContinueThrew = true; }
  check("codex: buildLaunch({continueSession}) throws", codexContinueThrew);

  // opencode + hermes THROW on resume and produce NO command (fail loud, never spawn fresh silently).
  // Hermes is excluded on win32 (its buildLaunch throws Unix-only regardless — asserted in §3).
  const unsupportedResume = onWin ? [opencodeConnector] : [opencodeConnector, hermesConnector];
  for (const con of unsupportedResume) {
    let threw = false;
    let spec: LaunchSpec | undefined;
    try { spec = con.buildLaunch({ ...base, resume: "sess-1" }); } catch { threw = true; }
    check(`${con.name}: buildLaunch({resume}) throws`, threw, spec);
  }
  // …but the common no-resume path still builds normally (the guard doesn't over-fire).
  for (const con of unsupportedResume) {
    let built = false;
    try { con.buildLaunch({ ...base }); built = true; } catch { /* unexpected */ }
    check(`${con.name}: no resume → builds normally`, built);
  }
  // MANAGER THREADING: startAgent({resume}) → LaunchOpts.resume verbatim, and absent → undefined.
  resetOpts();
  await mgr.startAgent({ name: "rrec1", agent: "smoke-rec", resume: "sess-thread" });
  check("startAgent resume threads into LaunchOpts.resume", lastOpts?.resume === "sess-thread", lastOpts?.resume);
  resetOpts();
  await mgr.startAgent({ name: "rrec2", agent: "smoke-rec" });
  check("no resume → LaunchOpts.resume undefined", lastOpts?.resume === undefined, lastOpts?.resume);
}

// 6 — RESUME CAPABILITY PREFLIGHT (#159 Part A): resume is a connector capability. A resume request for
// a connector that doesn't declare `supportsResume` is REJECTED before any side effect (no reserve, no
// mint, no buildLaunch) — mirrors the harness preflight; the buildLaunch throw stays the backstop.
{
  check("claude supportsResume === true", claudeConnector.supportsResume === true);
  check("opencode supportsResume falsy", !opencodeConnector.supportsResume, opencodeConnector.supportsResume);
  check("hermes supportsResume falsy", !hermesConnector.supportsResume, hermesConnector.supportsResume);

  // REJECT: smoke-norsm passes the node PATH check but declares no resume support.
  resetNoResumeBuilt();
  const before = agentCount();
  const reply = await mgr.startAgent({ name: "norsm1", agent: "smoke-norsm", resume: "sess-x" });
  check("unsupported-connector resume rejected", reply.ok === false, reply);
  check("reject names 'does not support resuming'", /does not support resuming/.test(reply.error ?? ""), reply.error);
  check("reject BEFORE buildLaunch (no spec built)", noResumeBuilt !== true);
  check("reject BEFORE side effect (no agent recorded)", agentCount() === before);

  // …but no resume → the same connector spawns normally (the preflight doesn't over-fire).
  resetNoResumeBuilt();
  const ok = await mgr.startAgent({ name: "norsm2", agent: "smoke-norsm" });
  check("no resume → unsupported-resume connector still spawns", ok.ok === true, ok);
  check("no resume → buildLaunch reached", noResumeBuilt === true);
}

// 7 — LAUNCH-FAILURE SURFACING (#159 B1): a detached spawn that dies on arrival must be reported as a
// FAILURE, not `✓ started`. Swap in a runtime whose handle is already exited (the dead-on-arrival shape
// a bad `--resume` id produces — `status()==="exited"`, backlog carrying the error); the readiness race
// takes the exit branch and startAgent returns {ok:false} with the child's last output + records no live
// agent. The STARTED path (joins presence) is exercised by every ok spawn above — the fake ep reports
// managed agents as joined, so readiness resolves started at once.
{
  const deadSession = {
    cols: 80, rows: 24,
    backlog: () => Buffer.from("\x1b[2mstarting…\x1b[0m\nError: No conversation found with session ID sess-x\n", "utf8"),
    onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {},
  };
  const deadHandle = (name: string): AgentHandle => ({
    name, kind: "fake", status: () => "exited", stop: () => {}, interrupt: () => {}, attach: () => deadSession,
  });
  (mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
    kind: "fake",
    spawn: (name) => deadHandle(name),
  };
  const before = agentCount();
  const reply = await mgr.startAgent({ name: "dead1", agent: "smoke-rec" });
  check("dead-on-arrival spawn reported as failure (not ✓ started)", reply.ok === false, reply);
  check("early-exit error names 'exited on launch'", /exited on launch/.test(reply.error ?? ""), reply.error);
  check("early-exit surfaces the child's last output as the cause", /No conversation found/.test(reply.error ?? ""), reply.error);
  check("early-exit strips ANSI from the surfaced output", !/\x1b\[/.test(reply.error ?? ""), reply.error);
  check("dead-on-arrival records no live agent", agentCount() === before, agentCount());
}

// 8 — MISSED-EXIT REAP (#159 B1, review hardening): an agent that joins presence (→ started) then dies in
// the window before watchExit subscribes would leak — a late onExit subscriber never hears the past event.
// watchExit re-checks status() right after subscribing and reaps it. Fake handle: status() reports
// "running" for the readiness race's single check (so it isn't seen as exited → resolves started via
// presence), then "exited" for watchExit's check (the missed exit); its onExit never fires — exactly the
// race. The agent must be removed, not left in the map.
{
  const goneSession = {
    cols: 80, rows: 24, backlog: () => Buffer.alloc(0),
    onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {},
  };
  const missedHandle = (name: string): AgentHandle => {
    let statusCalls = 0;
    return {
      name, kind: "fake",
      status: () => (++statusCalls <= 1 ? "running" : "exited"), // running for the readiness check, exited for watchExit
      stop: () => {}, interrupt: () => {}, attach: () => goneSession,
    };
  };
  (mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
    kind: "fake",
    spawn: (name) => missedHandle(name),
  };
  const before = agentCount();
  const reply = await mgr.startAgent({ name: "missed1", agent: "smoke-rec" });
  check("missed-exit: spawn joins presence (reports started)", reply.ok === true, reply);
  check("missed-exit: watchExit status-check reaps the leaked agent (not left in the map)", agentCount() === before, agentCount());
}

// 9 — SHUTDOWN TEARDOWN (#159 B2, review blocker): Manager.stop() must reap every managed agent — not just
// release the lease + stop endpoints — or a manager Ctrl-C/SIGTERM orphans their footprints (creds/durables/
// ACL). Spawn two survivors, then stop(): both children must be hard-stopped and the managed-agents map
// emptied. Broker deprovision is a no-op in open mode (its footprint teardown is proven under auth in
// deprovision-agent-auth.smoke); this proves the stop() wiring. Stub ep/attach so stop() has no live mesh.
{
  const stopped: string[] = [];
  const liveHandle = (name: string): AgentHandle => ({
    name, kind: "fake", status: () => "running",
    stop: () => { stopped.push(name); }, interrupt: () => {}, attach: () => fakeSession,
  });
  (mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
    kind: "fake",
    spawn: (name) => liveHandle(name),
  };
  (mgr as unknown as { ep: unknown }).ep = fakeEp({ releaseManagerLease: async () => {}, stop: async () => {} });
  (mgr as unknown as { attach: { stop: () => Promise<void> } }).attach = { stop: async () => {} };
  await mgr.startAgent({ name: "shut1", agent: "smoke-rec" });
  await mgr.startAgent({ name: "shut2", agent: "smoke-rec" });
  check("shutdown: two managed agents present before stop", agentCount() >= 2, agentCount());
  await mgr.stop();
  check("shutdown: stop() hard-stops every managed child", stopped.includes("shut1") && stopped.includes("shut2"), stopped);
  check("shutdown: stop() empties the managed-agents map (no orphaned footprint)", agentCount() === 0, agentCount());
}

// 10 — LEASE-LOSS TEARDOWN (#159 B2, review re-check): the fail-closed lease-loss exit (renewLease's catch)
// reaps managed agents through the SAME `teardownManagedAgents()` helper as stop(), so it can't process.exit
// while leaving footprints. renewLease's catch calls process.exit(1) (untestable inline), so assert the
// shared helper directly: it hard-stops every child + empties the map, touching no lease/endpoint.
{
  // First child's hard-stop THROWS (the tmux `closeWindow` / cmux `closeWorkspace` failure the panel
  // named) — the teardown must be best-effort per agent: still stop + free + deprovision the rest and
  // empty the map, never abort on one throw.
  const stopped: string[] = [];
  (mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
    kind: "fake",
    spawn: (name) => ({
      name, kind: "fake", status: () => "running",
      stop: () => { stopped.push(name); if (name === "lease1") throw new Error("simulated runtime close failure"); },
      interrupt: () => {}, attach: () => fakeSession,
    }),
  };
  await mgr.startAgent({ name: "lease1", agent: "smoke-rec" });
  await mgr.startAgent({ name: "lease2", agent: "smoke-rec" });
  await (mgr as unknown as { teardownManagedAgents: () => Promise<void> }).teardownManagedAgents();
  check("lease-loss: a throwing hard-stop doesn't abort teardown (every child attempted)", stopped.includes("lease1") && stopped.includes("lease2"), stopped);
  check("lease-loss: shared teardown empties the map despite a throwing stop", agentCount() === 0, agentCount());
}

// 11 — AUTHORITATIVE REAP: a throwing runtime hard-stop must not abort later siblings, but a recursive
// reap may not free either slot without waitForExit proof. These legacy fake handles have no wait contract,
// so both descendants stay inventoried rather than being declared gone while they may still live.
{
  const stopped: string[] = [];
  const handle = (name: string, throws: boolean): AgentHandle => ({
    name, kind: "fake", status: () => "running",
    stop: () => { stopped.push(name); if (throws) throw new Error("simulated runtime close failure"); },
    interrupt: () => {}, attach: () => fakeSession,
  });
  const agents = (mgr as unknown as { agents: Map<string, unknown> }).agents;
  const mk = (name: string, id: string, spawner: string, throws: boolean) =>
    ({ name, agent: "smoke", id, seed: "s", spawner, startedAt: Date.now(), handle: handle(name, throws), control: undefined });
  agents.set("parentR", mk("parentR", "idP", "mgr", false));
  agents.set("childR1", mk("childR1", "idC1", "idP", true)); // this child's stop THROWS
  agents.set("childR2", mk("childR2", "idC2", "idP", false));
  (mgr as unknown as { reapChildrenOf: (id: string) => void }).reapChildrenOf("idP");
  check("round5: a throwing child stop doesn't abort reap of siblings", stopped.includes("childR1") && stopped.includes("childR2"), stopped);
  check("recursive reap retains children without authoritative exit proof", agents.has("childR1") && agents.has("childR2"), [...agents.keys()]);
}

// 12 — UNCERTAIN READINESS (#159 B1): when neither presence nor exit is observed within the backstop, the
// launch is UNCERTAIN — a non-success reply that KEEPS the agent (it may still be booting), never a
// deprovision. Fake ep reports NOBODY joined; the handle stays running and never exits; short backstop.
{
  (mgr as unknown as { ep: unknown }).ep = fakeEp({}, () => []); // roster reports nobody → never "joins"
  (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 40;
  (mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
    kind: "fake",
    spawn: (name) => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession }),
  };
  const reply = await mgr.startAgent({ name: "unc1", agent: "smoke-rec" });
  check("uncertain: neither presence nor exit → non-success reply", reply.ok === false, reply);
  check("uncertain: reply names it 'uncertain'", /uncertain/i.test(reply.error ?? ""), reply.error);
  check("uncertain: the agent is KEPT (not deprovisioned — may still be booting)", agentsMap().has("unc1"), [...agentsMap().keys()]);
}

console.log(`\nSTART-MODEL/PREFLIGHT SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
