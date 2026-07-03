/**
 * Launch-grammar parity smoke (CLI rework stage 2a). Three surfaces express "launch an agent":
 * the CLI's `spawn` (foreground + --detach — ONE flag list by construction), the manager's
 * `start` control op, and the MCP `cotal_spawn` tool. The tier rule forbids a shared import
 * between connector-core and workspace, so parity is enforced HERE, by test:
 *   1. `spawnFlags` ⊇ the shared `launchFlags` bundle (spawn parses the whole grammar).
 *   2. Every launch flag maps onto a manager `start`-op key (the golden op vocabulary).
 *   3. Every MCP `cotal_spawn` schema param IS one of those op keys (subset — the tool may
 *      expose less, e.g. no `resume` by design, but never a divergent name).
 * Run: pnpm smoke:launch-parity
 */
import assert from "node:assert/strict";
import { launchFlags } from "@cotal-ai/workspace";
import { spawnFlags } from "@cotal-ai/cli";
import { configFromEnv, cotalToolSpecs } from "@cotal-ai/connector-core";

// cotalToolSpecs is capability-gated: cotal_spawn only renders for a spawn-capable agent.
process.env.COTAL_SPACE ||= "parity";
process.env.COTAL_NAME ||= "parity-1";
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";
process.env.COTAL_CAPABILITIES = "spawn";

/** The manager `start` op's argument vocabulary (StartAgentOpts, minus the internal `resolved`).
 *  Types are erased at runtime, so this list is the golden — a StartAgentOpts change must
 *  consciously edit it. */
const START_OP_KEYS = new Set([
  "name", "identity", "agent", "role", "config", "model", "resume", "transcript", "cwd",
  "prompt", "subscribe", "allowSubscribe", "allowPublish", "shareTools",
]);

/** CLI kebab flag → op key. `no-transcript` folds into the `transcript` tri-state; `--name` is
 *  the presence-identity OVERRIDE (op `identity`) — the persona REF rides the positional as op
 *  `name`. */
const flagToOpKey: Record<string, string> = {
  name: "identity",
  "share-tools": "shareTools",
  "allow-subscribe": "allowSubscribe",
  "allow-publish": "allowPublish",
  "no-transcript": "transcript",
};

// 1 — spawn parses the whole shared grammar.
const spawnNames = new Set(spawnFlags.map((f) => f.name));
for (const f of launchFlags) {
  assert.ok(spawnNames.has(f.name), `spawn is missing launch flag --${f.name}`);
}

// 2 — every launch flag lands on a start-op key.
for (const f of launchFlags) {
  const key = flagToOpKey[f.name] ?? f.name;
  assert.ok(START_OP_KEYS.has(key), `launch flag --${f.name} has no start-op key (${key})`);
}

// 3 — the MCP tool's params are a subset of the op vocabulary, names aligned.
const spawnTool = cotalToolSpecs(configFromEnv(), "parity-smoke").find((t) => t.name === "cotal_spawn") as
  | { name: string; schema: Record<string, unknown> }
  | undefined;
assert.ok(spawnTool, "cotal_spawn tool spec exists");
const toolParams = Object.keys(spawnTool.schema);
for (const p of toolParams) {
  assert.ok(START_OP_KEYS.has(p), `cotal_spawn param "${p}" is not a start-op key — vocabulary drift`);
}
// `resume` stays deliberately OFF the peer-facing tool (host-transcript disclosure — see the
// tool-specs note); this asserts today's intent so re-adding it is a conscious edit here too.
assert.ok(!toolParams.includes("resume"), "cotal_spawn must not expose resume (deferred, #159)");

console.log(`✓ launch-parity smoke passed (${launchFlags.length} grammar flags · ${toolParams.length} MCP params)`);
