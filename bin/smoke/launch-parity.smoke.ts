/**
 * Launch-grammar parity smoke (CLI rework stage 2a). Three surfaces express "launch an agent":
 * the CLI's `spawn` (foreground + --detach — ONE flag list by construction), the manager's
 * `start` control op, and the MCP `cotal_spawn` tool. The tier rule forbids a shared import
 * between connector-core and workspace, so parity is enforced HERE, by test:
 *   1. `spawnFlags` ⊇ the shared `launchFlags` bundle (spawn parses the whole grammar).
 *   2. Every launch flag maps onto a manager `start`-op key (the golden op vocabulary).
 *   3. Every MCP `cotal_spawn` schema param IS one of those op keys (subset — the tool may
 *      expose less, e.g. no `resume` by design, but never a divergent name).
 *   4. Every launch client's request window OUTLIVES the manager's readiness wait (#159 B1) —
 *      the manager replies to `start`/`launch` only on a real outcome, so a client timeout at or
 *      under that window kills real spawns while the launch proceeds.
 * Run: pnpm smoke:launch-parity
 */
import assert from "node:assert/strict";
import { launchFlags } from "@cotal-ai/workspace";
import { spawnFlags, launchAgent, START_TIMEOUT_MS } from "@cotal-ai/cli";
import { configFromEnv, cotalToolSpecs, SPAWN_TIMEOUT_MS } from "@cotal-ai/connector-core";
import { READINESS_TIMEOUT_MS } from "@cotal-ai/manager";
import type { CotalEndpoint } from "@cotal-ai/core";

// cotalToolSpecs is capability-gated: cotal_spawn only renders for a spawn-capable agent.
process.env.COTAL_SPACE ||= "parity";
process.env.COTAL_NAME ||= "parity-1";
// `||=` KEEPS an already-set value, so this suite is loopback only where nothing set the
// variable. In any shell that already exports COTAL_SERVERS — an agent's, an operator's — it
// resolves to that instead, and an archived run gave no way to tell which. It names its target
// now: a suite that names its target cannot silently change it. Measured, and true today: this
// suite opens no TCP connection to the value at all (verified against a listener that counted
// zero accepts), so the line discloses a CONFIG input, not traffic. If that ever stops being
// true, this line is already where a reader would look.
const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";
console.log(`• broker: ${process.env.COTAL_SERVERS} (${brokerFromEnv ? "INHERITED from the environment" : "suite default"})`);
process.env.COTAL_CAPABILITIES = "spawn";

/** The manager `start` op's argument vocabulary (StartAgentOpts, minus the internal `resolved`).
 *  Types are erased at runtime, so this list is the golden — a StartAgentOpts change must
 *  consciously edit it. */
const START_OP_KEYS = new Set([
  "name", "identity", "agent", "role", "config", "model", "variant", "launchOptions", "resume", "transcript", "cwd",
  "prompt", "subscribe", "allowSubscribe", "allowPublish", "shareTools",
]);

/** CLI kebab flag → op key. `no-transcript` folds into the `transcript` tri-state; `--name` is
 *  the presence-identity OVERRIDE (op `identity`) — the persona REF rides the positional as op
 *  `name`. */
const flagToOpKey: Record<string, string> = {
  name: "identity",
  opt: "launchOptions",
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

// 3 — the MCP tool's params are a subset of the op vocabulary, names aligned. The spec
// enumeration needs A config, not the AMBIENT session's: pass an empty env (open-mode defaults)
// so a connector-launched shell's COTAL_* vars (e.g. creds without a lifecycle uid) can't leak
// in and trip the authed-launch parse gate — this smoke is about vocabulary, not identity.
// `schema` is a closed Zod object; the argument names are on `.shape`. Reading the object itself
// enumerates Zod's internals and every one of them fails the vocabulary check below.
const spawnTool = cotalToolSpecs(configFromEnv({ COTAL_NAME: "parity-smoke" }), "parity-smoke").find((t) => t.name === "cotal_spawn") as
  | { name: string; schema: { shape: Record<string, unknown> } }
  | undefined;
assert.ok(spawnTool, "cotal_spawn tool spec exists");
const toolParams = Object.keys(spawnTool.schema.shape);
for (const p of toolParams) {
  assert.ok(START_OP_KEYS.has(p), `cotal_spawn param "${p}" is not a start-op key — vocabulary drift`);
}
// `resume` stays deliberately OFF the peer-facing tool (host-transcript disclosure — see the
// tool-specs note); this asserts today's intent so re-adding it is a conscious edit here too.
assert.ok(!toolParams.includes("resume"), "cotal_spawn must not expose resume (deferred, #159)");

// 4 — every launch client outlives the manager's readiness wait (#159 B1). The tier rule forbids
// the clients importing READINESS_TIMEOUT_MS, so the relation is enforced here, by test.
assert.ok(
  START_TIMEOUT_MS > READINESS_TIMEOUT_MS,
  `CLI START_TIMEOUT_MS (${START_TIMEOUT_MS}) must outlive the manager's readiness wait (${READINESS_TIMEOUT_MS})`,
);
assert.ok(
  SPAWN_TIMEOUT_MS > READINESS_TIMEOUT_MS,
  `connector SPAWN_TIMEOUT_MS (${SPAWN_TIMEOUT_MS}) must outlive the manager's readiness wait (${READINESS_TIMEOUT_MS})`,
);
// …and the manifest `launch` client actually PASSES that window (fake ep, no NATS) — `launch`
// funnels into the same startAgent readiness wait as `start`, so the 10s invoke default kills it
// too. launchAgent rides the v0.4 ep door (1c.2b), so the fake intercepts invokeService.
let launchTimeout: number | undefined;
let launchCommand: string | undefined;
const fakeEp = {
  invokeService: (_ep: string, command: string, _args?: Record<string, unknown>, opts?: { deadlineMs?: number }) => {
    launchCommand = command;
    launchTimeout = opts?.deadlineMs;
    return Promise.resolve({ reply: { ok: true } });
  },
} as unknown as CotalEndpoint;
await launchAgent(fakeEp, "run", "agent");
assert.equal(launchCommand, "launch", "launchAgent must invoke the manager's launch command");
assert.equal(launchTimeout, START_TIMEOUT_MS, "launchAgent must send the launch op with START_TIMEOUT_MS");

console.log(`✓ launch-parity smoke passed (${launchFlags.length} grammar flags · ${toolParams.length} MCP params · readiness window ${READINESS_TIMEOUT_MS}ms < clients ${START_TIMEOUT_MS}/${SPAWN_TIMEOUT_MS}ms)`);
