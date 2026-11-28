/**
 * Codex connector buildLaunch smoke (pure, no broker, no binary): the LaunchOpts → LaunchSpec
 * rendering and every declared fail-loud edge. Run: pnpm smoke:codex-args
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, registry } from "@cotal-ai/core";
import { configFromEnv, controlFromEnv } from "@cotal-ai/connector-core";
import { codexConnector } from "../src/index.js";
import { configOverrides } from "../src/codex-config.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const launch = (opts: import("@cotal-ai/core").LaunchOpts) => codexConnector.buildLaunch({ events: false, ...opts });
const throws = (name: string, fn: () => unknown, match: RegExp) => {
  try {
    fn();
  } catch (e) {
    check(name, match.test((e as Error).message), (e as Error).message);
    return;
  }
  assert.fail(`${name} — expected a throw`);
};

const dir = mkdtempSync(join(tmpdir(), "cotal-codexargs-"));
process.env.SUPER_SECRET_LEAK_CANARY = "leak-me";
process.env.OPENAI_API_KEY = "sk-test-canary";
try {
  // Self-registration: importing the package must register the connector under "codex".
  check("self-registers as connector codex", registry.resolve("connector", "codex") === codexConnector);

  // Base launch.
  const base = launch({ space: "s", name: "n" });
  check("host entry launched", base.args.length === 1 && /host/.test(base.args[0]), base.args);
  check("identity env", base.env?.COTAL_SPACE === "s" && base.env?.COTAL_NAME === "n");
  check("control endpoint minted", Boolean(base.control?.path && base.control?.token));
  // The socket PATH rides the env; the TOKEN rides the launch material, so a shell this seat runs
  // cannot pick a control-plane bearer out of its own environment. Both halves are asserted: the
  // absence alone would also pass on a launch that minted no control endpoint at all.
  check(
    "control socket path in env, token NOT in env",
    base.env?.COTAL_CONTROL_SOCKET === base.control?.path && base.env?.COTAL_CONTROL_KEY === undefined,
  );
  check(
    "control token recoverable from the launch material, matching the spec",
    controlFromEnv(base.env)?.token === base.control?.token,
  );
  check("codex data root defaults to the launch dir", base.env?.COTAL_CODEX_HOME === process.cwd());
  check("unrelated operator variable is withheld", base.env?.SUPER_SECRET_LEAK_CANARY === undefined);
  check("declared provider key is forwarded", base.env?.OPENAI_API_KEY === "sk-test-canary");
  check("ambient per-session COTAL_* is withheld", base.env?.COTAL_CREDS === undefined && base.env?.COTAL_LIFECYCLE_UID === undefined);

  process.env.COTAL_CODEX_BIN = "/operator/pinned-codex";
  try {
    const pinned = launch({ space: "s", name: "n", resolvedBinaries: { codex: "/boot/resolved-codex" } });
    check(
      "operator COTAL_CODEX_BIN wins over the manager boot fallback",
      pinned.env?.COTAL_CODEX_BIN === "/operator/pinned-codex" && pinned.env?.COTAL_CODEX_RESOLVED_BIN === "/boot/resolved-codex",
      pinned.env,
    );
  } finally {
    delete process.env.COTAL_CODEX_BIN;
  }

  // Workspace root pins the data root.
  const rooted = launch({ space: "s", name: "n", workspaceRoot: dir });
  check("workspaceRoot pins the codex data root", rooted.env?.COTAL_CODEX_HOME === dir);

  // Model + variant flags.
  const modeled = launch({ space: "s", name: "n", model: "gpt-5.6-sol", variant: "high" });
  check("model/variant ride env", modeled.env?.COTAL_MODEL === "gpt-5.6-sol" && modeled.env?.COTAL_VARIANT === "high");

  // Agent file: the launcher resolves its model/variant; the connector renders only what it is given.
  const agentFile = join(dir, "peer.md");
  writeFileSync(agentFile, `---\nname: peer\nmodel: gpt-5.5\nvariant: medium\n---\nYou are peer.\n`);
  const fromFile = launch({ space: "s", name: "peer", configPath: agentFile });
  check(
    "agent file model/variant are not re-read by the connector",
    fromFile.env?.COTAL_MODEL === undefined && fromFile.env?.COTAL_VARIANT === undefined && fromFile.env?.COTAL_AGENT_FILE === agentFile,
  );
  const flagWins = launch({ space: "s", name: "peer", configPath: agentFile, model: "gpt-5.6-sol" });
  check("the --model flag wins over the agent file", flagWins.env?.COTAL_MODEL === "gpt-5.6-sol");

  // Modes: Codex's one mode is the fast toggle, which the host renders as Codex's service tier.
  check("modes support is declared", codexConnector.supportsModes === true);
  const tier = (modes: Record<string, boolean | string>, extra = {}) => launch({ space: "s", name: "n", modes, ...extra }).env?.COTAL_CODEX_SERVICE_TIER;
  check("fast on selects Codex's priority tier", tier({ fast: true }) === "priority");
  check("fast off selects Codex's default tier", tier({ fast: false }) === "default");
  check("a launch that names no mode leaves the tier to Codex", base.env !== undefined && !("COTAL_CODEX_SERVICE_TIER" in base.env));
  throws("an unknown mode is refused", () => tier({ plan: true }), /mode "plan" is not one Codex offers/);
  throws("an unknown mode beside fast is refused", () => tier({ fast: true, plan: "x" }), /mode "plan" is not one Codex offers/);
  throws("a fast value that is not true or false is refused", () => tier({ fast: "yes" }), /takes true or false, not "yes"/);
  throws("a validate-only launch refuses an unknown mode too", () => tier({ plan: true }, { validateOnly: true }), /not one Codex offers/);

  // The fast mode and an operator service_tier both choose the tier, so the mix is refused at spawn.
  const opTierOpt = { launchOptions: { service_tier: '"flex"' } };
  const conflict = /mode "fast" and launch option "service_tier" both set Codex's service tier.*--opt service_tier=\.\.\. alone/;
  throws("fast on beside an operator service_tier is refused", () => tier({ fast: true }, opTierOpt), conflict);
  throws("fast off beside an operator service_tier is refused", () => tier({ fast: false }, opTierOpt), conflict);
  throws("a validate-only launch refuses the mix too", () => tier({ fast: true }, { ...opTierOpt, validateOnly: true }), conflict);
  const opOnly = launch({ space: "s", name: "n", ...opTierOpt }).env ?? {};
  check(
    "an operator service_tier alone still launches, with no mode tier",
    !("COTAL_CODEX_SERVICE_TIER" in opOnly) && JSON.parse(opOnly.COTAL_CODEX_CONFIG ?? "{}").service_tier === '"flex"',
    opOnly.COTAL_CODEX_CONFIG,
  );

  // The host renders the tier as a `-c service_tier` override, and refuses one beside an operator's.
  const serviceTiers = (o: [string, string][]) => o.filter(([k]) => k === "service_tier").map(([, v]) => v);
  const ownConfig = process.env.COTAL_CODEX_CONFIG;
  delete process.env.COTAL_CODEX_CONFIG;
  try {
    const rendered = serviceTiers(configOverrides(undefined, undefined, false, "priority"));
    check("a tier renders service_tier", rendered.length === 1 && rendered[0] === '"priority"', rendered);
    check("no tier renders no service_tier", serviceTiers(configOverrides(undefined, undefined, false, undefined)).length === 0);
    const asking = serviceTiers(configOverrides(undefined, undefined, true, "priority"));
    check("an askPermissions launch keeps its tier", asking.length === 1 && asking[0] === '"priority"', asking);
    process.env.COTAL_CODEX_CONFIG = JSON.stringify({ service_tier: '"flex"' });
    throws("the host refuses a tier beside an operator service_tier", () => configOverrides(undefined, undefined, false, "priority"), /both set the service tier/);
    const opTier = serviceTiers(configOverrides(undefined, undefined, false, undefined));
    check("an operator service_tier alone renders once", opTier.length === 1 && opTier[0] === '"flex"', opTier);
  } finally {
    if (ownConfig === undefined) delete process.env.COTAL_CODEX_CONFIG;
    else process.env.COTAL_CODEX_CONFIG = ownConfig;
  }

  // Launch options → -c override bag (rendered by the host); key-shape guard.
  const opted = launch({
    space: "s",
    name: "n",
    launchOptions: { approval_policy: '"untrusted"', model_verbosity: '"low"' },
  });
  check(
    "launch options ride COTAL_CODEX_CONFIG verbatim",
    JSON.parse(opted.env?.COTAL_CODEX_CONFIG ?? "{}").approval_policy === '"untrusted"',
    opted.env?.COTAL_CODEX_CONFIG,
  );
  throws(
    "an =-embedding launch-option key is refused",
    () => launch({ space: "s", name: "n", launchOptions: { "a=b": "1" } }),
    /not a valid flag name/,
  );
  throws(
    "a prototype-polluting launch-option key is refused",
    () =>
      launch({
        space: "s",
        name: "n",
        launchOptions: JSON.parse('{"__proto__":"x"}') as Record<string, unknown>,
      }),
    /not a valid flag name/,
  );

  // ACL + capabilities env rail.
  const acl = launch({
    space: "s",
    name: "n",
    subscribe: ["team"],
    allowSubscribe: ["team", "review.>"],
    allowPublish: ["team"],
    capabilities: ["spawn"],
  });
  check(
    "ACL env rail forwarded",
    acl.env?.COTAL_SUBSCRIBE === "team" &&
      acl.env?.COTAL_ALLOW_SUBSCRIBE === "team,review.>" &&
      acl.env?.COTAL_ALLOW_PUBLISH === "team" &&
      acl.env?.COTAL_CAPABILITIES === "spawn",
  );

  // Identity extras.
  const full = launch({
    space: "s",
    name: "n",
    role: "coder",
    id: "UAID",
    lifecycleUid: "lc-1",
    backfillFloor: 42,
    servers: "nats://x:1",
    prompt: "greet the operator",
  });
  check(
    "role/id/lifecycle/prompt forwarded",
    full.env?.COTAL_ROLE === "coder" &&
      full.env?.COTAL_ID === "UAID" &&
      full.env?.COTAL_LIFECYCLE_UID === "lc-1" &&
      full.env?.COTAL_CODEX_PROMPT === "greet the operator",
  );
  check("backfill floor forwarded", full.env?.COTAL_BACKFILL_FLOOR === "42", full.env?.COTAL_BACKFILL_FLOOR);
  // The broker URL is NOT one of them: it rides the launch material, so a suite or a tool this seat
  // runs cannot resolve its "default" broker out of an inherited variable and silently dial ours.
  check(
    "broker URL delivered by launch material, not by env",
    full.env?.COTAL_SERVERS === undefined && configFromEnv(full.env).servers === "nats://x:1",
  );

  // A prompt is trimmed on the way in, and a prompt with no text refuses the launch (never dropped).
  check(
    "prompt is trimmed",
    launch({ space: "s", name: "n", prompt: "  greet  " }).env?.COTAL_CODEX_PROMPT === "greet",
  );
  let emptyPromptRefused = false;
  try {
    launch({ space: "s", name: "n", prompt: "   " });
  } catch (e) {
    emptyPromptRefused = /empty/.test(String((e as Error).message));
  }
  check("an empty prompt refuses the launch", emptyPromptRefused);

  // User-mode auth rail + the one-identity-plane rule.
  const user = launch({
    space: "s",
    name: "n",
    userAuth: { owner: "o", actor: "a", sentinelCredsPath: "/tmp/sc", bearerCmd: ["cmd", "arg"] },
  });
  // Forwarded through the launch material, not the environment: the sentinel creds path and the
  // bearer command are the user-mode equivalent of a credential, and a build script the seat runs
  // has no more business holding them than it has holding a creds file.
  check(
    "user-mode auth rail NOT in the seat env",
    user.env?.COTAL_OWNER === undefined && user.env?.COTAL_ACTOR === undefined && user.env?.COTAL_BEARER_CMD === undefined,
  );
  check("user-mode auth rail forwarded through the launch material", (() => {
    const m = readLaunchMaterial(user.env?.[LAUNCH_MATERIAL_ENV] as string);
    return (
      m.userAuth?.owner === "o" &&
      m.userAuth?.actor === "a" &&
      m.userAuth?.sentinelCredsPath === "/tmp/sc" &&
      m.userAuth?.bearerCmd.join(",") === "cmd,arg"
    );
  })());
  throws(
    "creds + userAuth is refused (one identity plane)",
    () =>
      launch({
        space: "s",
        name: "n",
        creds: "/tmp/creds",
        userAuth: { owner: "o", actor: "a", sentinelCredsPath: "/tmp/sc", bearerCmd: ["c"] },
      }),
    /mutually exclusive/,
  );

  // Declared-unsupported features fail loud.
  throws(
    "resume is refused (a resumed thread has no cotal_* MCP tools)",
    () => launch({ space: "s", name: "n", resume: "0199-abc" }),
    /resum/i,
  );
  throws(
    "the whole mcp_servers namespace is reserved (top-level table, the reachable shape)",
    () => launch({ space: "s", name: "n", launchOptions: { mcp_servers: '{ evil = { url = "http://x" } }' } }),
    /reserved/i,
  );
  throws(
    "tool-sharing is refused",
    () => launch({ space: "s", name: "n", mcpServers: { srv: { command: "x" } } }),
    /tool-sharing/,
  );
  // The TUI/headless choice is derived from the host's own stdout, and COTAL_CODEX_TUI overrides
  // it. The child's env is an ALLOW-LIST, so an override that is not forwarded BY NAME is
  // advertised and unreachable through the one path operators actually use.
  const noTui = launch({ space: "s", name: "n" });
  check("COTAL_CODEX_TUI is absent when the operator did not set it", noTui.env?.COTAL_CODEX_TUI === undefined);
  process.env.COTAL_CODEX_TUI = "0";
  try {
    const forced = launch({ space: "s", name: "n" });
    check("COTAL_CODEX_TUI reaches the host through the env allow-list", forced.env?.COTAL_CODEX_TUI === "0");
  } finally {
    delete process.env.COTAL_CODEX_TUI;
  }
  // What the operator is told to expect on a foreground spawn is the CONNECTOR's to say: another
  // harness's first-run gate named here sends them looking for a prompt that never appears.
  check(
    "a launch hint is declared, and does not promise another harness's prompt",
    typeof codexConnector.launchHint === "string" &&
      codexConnector.launchHint.length > 0 &&
      !/dev-channels/.test(codexConnector.launchHint),
    codexConnector.launchHint,
  );
  check("variant support is declared", codexConnector.supportsModelVariant === true);
  check("resume support is NOT declared (pre-mint preflight)", codexConnector.supportsResume !== true);
  check("requires names the codex binary", Array.isArray(codexConnector.requires) && codexConnector.requires.includes("codex"));

  console.log(`\n${pass} checks passed`);
} finally {
  delete process.env.SUPER_SECRET_LEAK_CANARY;
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
