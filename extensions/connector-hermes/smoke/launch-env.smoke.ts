/**
 * Launch-env allow-list (no test runner).
 *
 * A spawned Hermes seat receives the OS allow-list, OPERATOR_ENV_KEEP, and this connector's
 * declared provider keys. Host-session markers and unrelated operator secrets stay out unless
 * named on spawn.env. Per-session COTAL_* never crosses from this process into the child.
 *
 * Run: pnpm --filter @cotal-ai/connector-hermes test
 */
import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesUvCommand, spawnHermesGateway } from "../src/binary.js";
import { hermesConnector } from "../src/extension.js";
import { ADOPT_HOME_ENV, adoptedHome, assertHermesVersion, setupAdoptedProfile } from "../src/launch.js";

if (process.platform === "win32") {
  console.log("✓ launch-env smoke skipped on Windows (the Hermes connector is Unix-only; buildLaunch throws)");
  process.exit(0);
}

/** The provider keys this connector declares. They must still arrive. */
const PROVIDER_KEYS = [
  "OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "NOUS_API_KEY",
  "OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "NOVITA_API_KEY",
  "DEEPSEEK_API_KEY", "GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY", "KIMI_API_KEY",
  "KIMI_CODING_API_KEY", "KIMI_CN_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY",
  "DASHSCOPE_API_KEY", "ALIBABA_CODING_PLAN_API_KEY", "STEPFUN_API_KEY", "ARCEEAI_API_KEY",
  "GMI_API_KEY", "NVIDIA_API_KEY", "KILOCODE_API_KEY", "XIAOMI_API_KEY", "TOKENHUB_API_KEY",
  "OLLAMA_API_KEY", "AZURE_FOUNDRY_API_KEY",
] as const;

/** Host / VCS / cloud names this connector does not declare. None may cross on the default path. */
const FORMERLY_EXCLUDED = [
  "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "HF_TOKEN", "ANTHROPIC_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN", "GOOGLE_API_KEY", "LM_API_KEY", "QWEN_API_KEY",
] as const;

const HOST_MARKERS = [
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE",
] as const;

/** One name from every per-session family a connector assigns conditionally. None may cross. */
const PER_SESSION = [
  "COTAL_LAUNCH_MATERIAL", "COTAL_CREDS", "COTAL_SERVERS", "COTAL_CONTROL_TOKEN",
  "COTAL_CONTROL_SOCKET", "COTAL_OWNER", "COTAL_ACTOR", "COTAL_SENTINEL_CREDS", "COTAL_BEARER_CMD",
  "COTAL_HERMES_UV_BIN",
  "COTAL_LIFECYCLE_UID", "COTAL_ID", "COTAL_ROLE", "COTAL_MODEL", "COTAL_VARIANT",
  "COTAL_AGENT_FILE", "COTAL_LINK", "COTAL_SUBSCRIBE", "COTAL_ALLOW_SUBSCRIBE",
  "COTAL_ALLOW_PUBLISH", "COTAL_CAPABILITIES", "COTAL_EVENTS", "COTAL_WORKSPACE_ROOT",
  "COTAL_CHANNEL", "COTAL_CODEX_HOME", "COTAL_OPENCODE_PROMPT", "COTAL_TOKEN",
] as const;

/** Machine-wide operator knobs that DO cross: no connector assigns them per spawn. */
const OPERATOR_KNOBS = ["COTAL_HOME", "COTAL_FEEDBACK_KEY", "COTAL_CODEX_BIN"] as const;

for (const k of [...PROVIDER_KEYS, ...FORMERLY_EXCLUDED, ...HOST_MARKERS]) process.env[k] = `smoke-${k}`;
for (const k of [...PER_SESSION, ...OPERATOR_KNOBS]) process.env[k] = `parent-${k}`;
process.env.SOME_UNRELATED_SECRET = "smoke-unrelated";

// ── Default allow-list (no operator extras declared) ─────────────────────────────────────────────
const env = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1" }).env ?? {};

for (const k of PROVIDER_KEYS)
  assert.equal(env[k], `smoke-${k}`, `${k} must reach the child: this connector declares it`);
for (const k of FORMERLY_EXCLUDED)
  assert.ok(!(k in env), `${k} must not reach the child: it is not on this connector's allow-list`);
assert.ok(!("SOME_UNRELATED_SECRET" in env), "an unrelated operator variable is withheld");
for (const k of HOST_MARKERS)
  assert.ok(!(k in env), `${k} leaked from this process into the child: a host-session marker must be withheld`);

for (const k of PER_SESSION)
  assert.ok(!(k in env), `${k} leaked from this process into the child: a per-session name must be reset, not inherited`);

assert.equal(env.COTAL_SPACE, "smoke", "the connector supplies this child's space");
assert.equal(env.COTAL_NAME, "hermes-1", "the connector supplies this child's name");
assert.ok(env.PATH !== undefined, "PATH is forwarded so the seat can still launch");

for (const k of OPERATOR_KNOBS)
  assert.equal(env[k], `parent-${k}`, `${k} is a machine-wide operator knob and must cross`);

// ── Allow-list extras (the operator declared `spawn.env`) ─────────────────────────────────────────
const confined = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-2", envAllow: ["NOUS_API_KEY"] }).env ?? {};

assert.equal(confined.NOUS_API_KEY, "smoke-NOUS_API_KEY", "a declared name is forwarded under containment");
assert.ok(!("GH_TOKEN" in confined), "an undeclared name is withheld under containment");
assert.ok(!("SOME_UNRELATED_SECRET" in confined), "containment means the OS allow-list plus the declared names, nothing else");
assert.ok(confined.PATH !== undefined, "the OS allow-list still carries what the child needs to run");
for (const k of PER_SESSION)
  assert.ok(!(k in confined), `${k} must be absent under containment too`);
for (const k of HOST_MARKERS)
  assert.ok(!(k in confined), `${k} must stay withheld when spawn.env names something else`);

// Opt-in: a persona / operator that names a host marker gets it. The default path never does.
const opted = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-4", envAllow: ["CLAUDE_CODE_CHILD_SESSION"] }).env ?? {};
assert.equal(opted.CLAUDE_CODE_CHILD_SESSION, "smoke-CLAUDE_CODE_CHILD_SESSION", "a host marker named on spawn.env is the explicit opt-in");
assert.ok(!("CLAUDECODE" in opted), "an unnamed host marker stays withheld even when a sibling is opted in");

// An empty array is a POLICY (the OS allow-list alone), not "unset". If this were read as unset the
// child would inherit everything, which is the one way the opt-in could silently fail open.
const bare = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-3", envAllow: [] }).env ?? {};
assert.equal(bare.NOUS_API_KEY, "smoke-NOUS_API_KEY", "empty spawn.env does not drop connector-declared provider keys");
assert.ok(!("GH_TOKEN" in bare), "empty spawn.env still withholds undeclared names");
assert.ok(bare.PATH !== undefined, "an empty spawn.env still carries the OS allow-list");

assert.throws(
  () => hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1", prompt: "greet the operator" }),
  /initial prompt/,
  "a prompt the connector cannot submit must refuse the launch",
);

const bootResolved = hermesConnector.buildLaunch({
  space: "smoke",
  name: "hermes-boot-resolved",
  resolvedBinaries: { uv: "/manager/boot/uv" },
}).env ?? {};
assert.equal(bootResolved.COTAL_HERMES_UV_BIN, "/manager/boot/uv", "the exact manager-boot uv path reaches the launcher");
assert.equal(hermesUvCommand(bootResolved), "/manager/boot/uv", "the launcher executes the exact manager-boot uv path");

let spawned: { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
spawnHermesGateway({
  pkgDir: "/connector/hermes",
  env: bootResolved,
  spawnImpl: ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    spawned = { command, args, env: options.env };
    return {} as ChildProcess;
  }) as typeof import("node:child_process").spawn,
});
assert.deepEqual(
  spawned,
  {
    command: "/manager/boot/uv",
    args: ["run", "--project", "/connector/hermes", "hermes", "gateway", "run"],
    env: bootResolved,
  },
  "the gateway spawn executes the exact manager-boot uv path",
);

let inspected: { command: string; args: readonly string[] } | undefined;
assertHermesVersion({
  env: bootResolved,
  pkgDir: "/connector/hermes",
  execFileImpl: (command, args) => {
    inspected = { command, args };
    return "0.21.1\n";
  },
  logImpl: () => {},
});
assert.deepEqual(
  inspected,
  {
    command: "/manager/boot/uv",
    args: ["run", "--project", "/connector/hermes", "--quiet", "python", "-c", "from importlib.metadata import version; print(version('hermes-agent'))"],
  },
  "version inspection executes the exact manager-boot uv path",
);

// ── The supported hermes-agent range (#1531) ─────────────────────────────────────────────────────
// This guard used to be an equality test fed exactly one version, "0.16.7", by exactly one call.
// A suite that only ever supplies an accepted version cannot tell an equality test from a range
// test, so it stayed green on a tree that refused every hermes-agent an operator could install.
// Both ends of the range are asserted here, and so is the shape of the check: a REFUSE row for a
// version just outside each end, an ACCEPT row for the version just inside it.
const checkVersion = (raw: string): void =>
  assertHermesVersion({
    env: bootResolved,
    pkgDir: "/connector/hermes",
    execFileImpl: () => `${raw}\n`,
    logImpl: () => {},
  });

/** Versions inside the supported range: every one must be accepted. */
const SUPPORTED = ["0.18.0", "0.18.1", "0.18.2", "0.19.0", "0.19.1", "0.20.1", "0.21.0", "0.21.1", "0.21.2"] as const;
/** Below the floor: the gateway never passes is_reconnect on these lines. */
const BELOW_FLOOR = ["0.16.0", "0.16.7", "0.17.0"] as const;
/** At or above the ceiling: unverified contract, so refused rather than assumed. */
const ABOVE_CEILING = ["0.22.0", "0.23.0", "1.0.0"] as const;

for (const v of SUPPORTED)
  assert.doesNotThrow(() => checkVersion(v), `hermes-agent ${v} is inside the supported range and must launch`);

for (const v of BELOW_FLOOR)
  assert.throws(() => checkVersion(v), /below the 0\.18 floor/, `hermes-agent ${v} is under the floor and must be refused`);

for (const v of ABOVE_CEILING)
  assert.throws(() => checkVersion(v), /at or above the 0\.22 ceiling/, `hermes-agent ${v} is over the ceiling and must be refused`);

// 0.21.0 is the version this issue was filed about, and 0.19.0 is what PyPI actually resolves to
// today. Both are named individually so a future narrowing of the range fails on the two versions
// operators really run, not merely on an abstract boundary.
assert.doesNotThrow(() => checkVersion("0.21.0"), "the version from the report must launch");
assert.doesNotThrow(() => checkVersion("0.19.0"), "the version a plain pip/uv resolve installs must launch");

// A range test compared as STRINGS would place "0.9" above "0.18" and admit it. This is the row
// that tells the two implementations apart, and it is why the comparison is numeric.
assert.throws(() => checkVersion("0.9.0"), /below the 0\.18 floor/, "0.9 is below 0.18 numerically, whatever a string compare says");

// An unreadable version must be refused, not waved through: "could not tell" is the one answer a
// guard against unknown versions must never treat as a pass.
for (const junk of ["", "not-a-version", "0", "x.y.z"])
  assert.throws(() => checkVersion(junk), /could not read a major\.minor|below the 0\.18 floor/, `an unreadable version ${JSON.stringify(junk)} must be refused`);

// The accepted-version log line names the range, so an operator reading the launcher's output can
// see what was allowed rather than only that something passed.
let logged = "";
assertHermesVersion({
  env: bootResolved,
  pkgDir: "/connector/hermes",
  execFileImpl: () => "0.21.1\n",
  logImpl: (m) => {
    logged = m;
  },
});
assert.match(logged, /hermes-agent 0\.21\.1 \(supported range >=0\.18,<0\.22\)/, "the accept log names the version and the range");

// The TS guard and the resolver constraint are two halves of one pin: widening one alone leaves
// the other refusing what it resolves, which is what made option 2 in the report unworkable.
const pyproject = readFileSync(new URL("../pyproject.toml", import.meta.url), "utf8");
assert.match(pyproject, /^\s*"hermes-agent>=0\.18,<0\.22",\s*$/m, "pyproject.toml declares the same range the launcher enforces");

// ── Adopt an existing Hermes profile (#1531, second report) ──────────────────────────────────────
// The managed default writes a disposable profile so ~/.hermes is never touched. That serves a
// fresh seat and cannot serve an operator who wants their OWN Hermes, with its credentials and
// integrations, on the mesh. The opt-in must install this connector's plugin and change nothing
// else, because the managed path's config.yaml and SOUL.md writes would destroy a real profile.
assert.equal(adoptedHome({}), undefined, "no opt-in means the managed disposable profile");
assert.equal(adoptedHome({ [ADOPT_HOME_ENV]: "   " }), undefined, "a blank opt-in is not an opt-in");
assert.equal(adoptedHome({ [ADOPT_HOME_ENV]: "/home/op/.hermes" }), "/home/op/.hermes", "the opt-in names the profile to adopt");

const opAdopt = mkdtempSync(join(tmpdir(), "cotal-hermes-adopt-"));
assert.throws(
  () => setupAdoptedProfile(join(opAdopt, "no-such-profile"), {}),
  /does not exist/,
  "adopting a profile that is not there must fail loudly, not create one",
);

// An enabled profile: the plugin lands and nothing else is rewritten.
const OP_CONFIG = [
  "model: my-own-model",
  "approvals:",
  "  mode: prompt",
  "plugins:",
  "  enabled: [cotal, telegram]",
  "gateway:",
  "  platforms:",
  "    cotal:",
  "      enabled: true",
  "",
].join("\n");
const OP_SOUL = "I am the operator's own Hermes.\n";
writeFileSync(join(opAdopt, "config.yaml"), OP_CONFIG);
writeFileSync(join(opAdopt, "SOUL.md"), OP_SOUL);
setupAdoptedProfile(opAdopt, {});
assert.ok(existsSync(join(opAdopt, "plugins", "cotal", "adapter.py")), "the cotal plugin is installed into the adopted profile");
assert.equal(readFileSync(join(opAdopt, "config.yaml"), "utf8"), OP_CONFIG, "the operator's config.yaml is left exactly as it was");
assert.equal(readFileSync(join(opAdopt, "SOUL.md"), "utf8"), OP_SOUL, "the operator's SOUL.md is left exactly as it was");

// A persona cannot be honoured without overwriting SOUL.md, so it is refused rather than dropped.
assert.throws(
  () => setupAdoptedProfile(opAdopt, { persona: "be a helpful reviewer" }),
  /persona cannot be applied/,
  "a persona that would overwrite the operator's SOUL.md must refuse the launch",
);

// A profile that has not enabled the plugin is told what to add, and is NOT edited into shape.
const opBare = mkdtempSync(join(tmpdir(), "cotal-hermes-adopt-bare-"));
const BARE_CONFIG = "model: my-own-model\n";
writeFileSync(join(opBare, "config.yaml"), BARE_CONFIG);
assert.throws(
  () => setupAdoptedProfile(opBare, {}),
  /does not enable the cotal plugin and platform/,
  "an unenabled profile must be reported, not silently reconfigured",
);
assert.equal(readFileSync(join(opBare, "config.yaml"), "utf8"), BARE_CONFIG, "a refused adopt still leaves the operator's config untouched");

// The opt-in has to survive the launch env or the launcher never sees it: every other COTAL_* name
// is deliberately reset per session, and this one would be stripped with them.
process.env.COTAL_HERMES_ADOPT_HOME = "/home/op/.hermes";
const adoptEnv = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-adopt" }).env ?? {};
assert.equal(adoptEnv.COTAL_HERMES_ADOPT_HOME, "/home/op/.hermes", "the adopt-home opt-in reaches the launcher");
delete process.env.COTAL_HERMES_ADOPT_HOME;
const plainEnv = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-plain" }).env ?? {};
assert.ok(!("COTAL_HERMES_ADOPT_HOME" in plainEnv), "without the opt-in the child gets the managed default");

rmSync(opAdopt, { recursive: true, force: true });
rmSync(opBare, { recursive: true, force: true });

console.log(
  `hermes-agent range: ${SUPPORTED.length} supported versions accepted, ` +
    `${BELOW_FLOOR.length} below-floor and ${ABOVE_CEILING.length} above-ceiling versions refused, ` +
    "numeric-vs-string ordering held, unreadable versions refused, pyproject range matched",
);
console.log("adopt-home: plugin installed, operator config.yaml and SOUL.md untouched, unenabled profile refused, opt-in crosses the launch env");

console.log(
  `launch-env smoke: ${PROVIDER_KEYS.length} declared provider keys forwarded, ` +
    `${FORMERLY_EXCLUDED.length + HOST_MARKERS.length + 1} undeclared names withheld, ` +
    `${PER_SESSION.length} per-session names reset, ${OPERATOR_KNOBS.length} operator knobs crossed, both modes held`,
);
