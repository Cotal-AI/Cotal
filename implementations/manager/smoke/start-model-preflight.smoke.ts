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
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { Manager } from "../src/manager.js";
import { registry, type Connector, type LaunchOpts, type LaunchSpec, type AgentHandle } from "@cotal-ai/core";
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
for (const n of ["reject1", "rec1", "rec2", "rrec1", "rrec2"]) writeFileSync(join(agentsDir, `${n}.md`), `---\nname: ${n}\n---\n`);
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
(mgr as unknown as { ep: { ref: () => { id: string } } }).ep = { ref: () => ({ id: "smoke-mgr" }) };
const agentCount = () => (mgr as unknown as { agents: Map<string, unknown> }).agents.size;

// A recording connector that requires `node` (present whenever this smoke runs) — captures the
// LaunchOpts the manager hands it, so we can assert the model threads through verbatim.
let lastOpts: LaunchOpts | undefined;
const recCon: Connector = {
  kind: "connector",
  name: "smoke-rec",
  requires: ["node"],
  buildLaunch: (o) => { lastOpts = o; return { command: "true", args: [], env: {} }; },
};
registry.register(recCon);

// 1 — Preflight REJECT: hide PATH so `claude` can't be found; the real claude connector requires it.
{
  const savedPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "cotal-empty-path-")); // a dir with no executables
  const reply = await mgr.startAgent({ name: "reject1", agent: "claude" });
  process.env.PATH = savedPath;
  check("missing harness binary is rejected", reply.ok === false, reply);
  check(
    "reject error names the missing binary, no PATH contents",
    reply.error === "claude harness needs claude on PATH — not found",
    reply.error,
  );
  check("reject happens before any side effect (no agent recorded)", agentCount() === 0);
}

// 2 — Model THREADING through the manager into LaunchOpts (PATH restored → `node` present again).
{
  lastOpts = undefined;
  const reply = await mgr.startAgent({ name: "rec1", agent: "smoke-rec", model: "sonnet" });
  check("present-binary connector passes preflight + spawns", reply.ok === true, reply);
  check("--model threads into LaunchOpts.model verbatim", lastOpts?.model === "sonnet", lastOpts?.model);
  check("built spec was captured (success path ran)", lastSpec?.command === "true");

  lastOpts = undefined;
  await mgr.startAgent({ name: "rec2", agent: "smoke-rec" });
  check("no --model → LaunchOpts.model undefined", lastOpts?.model === undefined, lastOpts?.model);

  // ACL threading: the resolved read/post set must reach the connector via LaunchOpts (the bug —
  // it was minted into creds but never handed to buildLaunch, so the connector fell back to general).
  lastOpts = undefined;
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
  lastOpts = undefined;
  await mgr.startAgent({ name: "rrec1", agent: "smoke-rec", resume: "sess-thread" });
  check("startAgent resume threads into LaunchOpts.resume", lastOpts?.resume === "sess-thread", lastOpts?.resume);
  lastOpts = undefined;
  await mgr.startAgent({ name: "rrec2", agent: "smoke-rec" });
  check("no resume → LaunchOpts.resume undefined", lastOpts?.resume === undefined, lastOpts?.resume);
}

console.log(`\nSTART-MODEL/PREFLIGHT SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
