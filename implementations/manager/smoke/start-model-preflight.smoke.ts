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

// A workspace with no cotal *config*. A manager spawn now REQUIRES a discoverable persona (no
// silent default-ACL fallback), so seed a minimal `.cotal/agents/<name>.md` per spawned name —
// this test's subject is harness preflight + model threading, not persona/ACL resolution.
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-start-ws-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
for (const n of ["reject1", "rec1", "rec2"]) writeFileSync(join(agentsDir, `${n}.md`), `---\nname: ${n}\n---\n`);
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

  // flag wins over the agent file's `model:`
  check("claude: flag beats frontmatter", claudeModel(claudeConnector.buildLaunch({ ...base, configPath: af, model: "sonnet" })) === "sonnet");
  check("opencode: flag beats frontmatter", ocModel(opencodeConnector.buildLaunch({ ...base, configPath: af, model: "sonnet" })) === "sonnet");
  check("hermes: flag beats frontmatter", hermesModel(hermesConnector.buildLaunch({ ...base, configPath: af, model: "sonnet" })) === "sonnet");

  // flag applies with NO agent file (the gap the fix closes)
  check("claude: flag with no agent file", claudeModel(claudeConnector.buildLaunch({ ...base, model: "sonnet" })) === "sonnet");
  check("opencode: flag with no agent file", ocModel(opencodeConnector.buildLaunch({ ...base, model: "sonnet" })) === "sonnet");
  check("hermes: flag with no agent file", hermesModel(hermesConnector.buildLaunch({ ...base, model: "sonnet" })) === "sonnet");

  // no flag → agent-file model is the fallback (incl. Hermes, whose launcher previously ignored it)
  check("claude: no flag → frontmatter opus", claudeModel(claudeConnector.buildLaunch({ ...base, configPath: af })) === "opus");
  check("opencode: no flag → frontmatter opus", ocModel(opencodeConnector.buildLaunch({ ...base, configPath: af })) === "opus");
  check("hermes: no flag → frontmatter opus", hermesModel(hermesConnector.buildLaunch({ ...base, configPath: af })) === "opus");

  // nothing set → no model applied
  check("claude: nothing → no --model", claudeModel(claudeConnector.buildLaunch({ ...base })) === undefined);
  check("opencode: nothing → no config.model", ocModel(opencodeConnector.buildLaunch({ ...base })) === undefined);
  check("hermes: nothing → no HERMES_MODEL", hermesModel(hermesConnector.buildLaunch({ ...base })) === undefined);

  // 4 — ACL ENV emission: each connector forwards the resolved policy so the spawned session's
  // runtime read/post set matches its minted creds. Wildcard allowSubscribe (team.>) must survive.
  const acl = { subscribe: ["team"], allowSubscribe: ["team", "team.>"], allowPublish: ["team"] };
  for (const con of [claudeConnector, opencodeConnector, hermesConnector]) {
    const env = con.buildLaunch({ ...base, ...acl }).env!;
    check(`${con.name}: COTAL_SUBSCRIBE forwarded`, env.COTAL_SUBSCRIBE === "team", env.COTAL_SUBSCRIBE);
    check(`${con.name}: COTAL_ALLOW_SUBSCRIBE forwarded (wildcard kept)`, env.COTAL_ALLOW_SUBSCRIBE === "team,team.>", env.COTAL_ALLOW_SUBSCRIBE);
    check(`${con.name}: COTAL_ALLOW_PUBLISH forwarded`, env.COTAL_ALLOW_PUBLISH === "team", env.COTAL_ALLOW_PUBLISH);
    // No policy → no env (persona-spawn / no-channel path unchanged: connector reads the file or
    // falls back to the general baseline — never silently overridden to empty).
    check(`${con.name}: no policy → COTAL_SUBSCRIBE absent`, con.buildLaunch({ ...base }).env!.COTAL_SUBSCRIBE === undefined);
  }
}

console.log(`\nSTART-MODEL/PREFLIGHT SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
