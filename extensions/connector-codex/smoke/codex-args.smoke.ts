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

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
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
  const base = codexConnector.buildLaunch({ space: "s", name: "n" });
  check("host entry launched", base.args.length === 1 && /host/.test(base.args[0]), base.args);
  check("identity env", base.env?.COTAL_SPACE === "s" && base.env?.COTAL_NAME === "n");
  check("control endpoint minted", Boolean(base.control?.path && base.control?.token));
  // The socket PATH rides the env; the TOKEN rides the launch material, so a shell this seat runs
  // cannot pick a control-plane bearer out of its own environment. Both halves are asserted: the
  // absence alone would also pass on a launch that minted no control endpoint at all.
  check(
    "control socket path in env, token NOT in env",
    base.env?.COTAL_CONTROL_SOCKET === base.control?.path && base.env?.COTAL_CONTROL_TOKEN === undefined,
  );
  check(
    "control token recoverable from the launch material, matching the spec",
    controlFromEnv(base.env)?.token === base.control?.token,
  );
  check("codex data root defaults to the launch dir", base.env?.COTAL_CODEX_HOME === process.cwd());
  // Flipped with the env default: a spawned agent inherits the operator's environment, so both of
  // these arrive. The canary is kept rather than deleted because asserting its PRESENCE is the
  // sharpest statement of the change, and a reviewer reads the inversion instead of a missing cell.
  check("env is inherited: an unrelated operator variable IS forwarded", base.env?.SUPER_SECRET_LEAK_CANARY === "leak-me");
  check("env is inherited: the provider key arrives without a vendor list", base.env?.OPENAI_API_KEY === "sk-test-canary");
  // What is NOT inherited is Cotal's own per-session namespace: the codex connector mints
  // COTAL_CODEX_HOME per launch (asserted above), so an inherited one must never reach the child.
  check("per-session COTAL_* is reset, not inherited", base.env?.COTAL_CREDS === undefined && base.env?.COTAL_LIFECYCLE_UID === undefined);

  // Workspace root pins the data root.
  const rooted = codexConnector.buildLaunch({ space: "s", name: "n", workspaceRoot: dir });
  check("workspaceRoot pins the codex data root", rooted.env?.COTAL_CODEX_HOME === dir);

  // Model + variant flags.
  const modeled = codexConnector.buildLaunch({ space: "s", name: "n", model: "gpt-5.6-sol", variant: "high" });
  check("model/variant ride env", modeled.env?.COTAL_MODEL === "gpt-5.6-sol" && modeled.env?.COTAL_VARIANT === "high");

  // Agent file: model/variant defaults, flags win.
  const agentFile = join(dir, "peer.md");
  writeFileSync(agentFile, `---\nname: peer\nmodel: gpt-5.5\nvariant: medium\n---\nYou are peer.\n`);
  const fromFile = codexConnector.buildLaunch({ space: "s", name: "peer", configPath: agentFile });
  check(
    "agent file supplies model/variant defaults",
    fromFile.env?.COTAL_MODEL === "gpt-5.5" && fromFile.env?.COTAL_VARIANT === "medium" && fromFile.env?.COTAL_AGENT_FILE === agentFile,
  );
  const flagWins = codexConnector.buildLaunch({ space: "s", name: "peer", configPath: agentFile, model: "gpt-5.6-sol" });
  check("the --model flag wins over the agent file", flagWins.env?.COTAL_MODEL === "gpt-5.6-sol");

  // Launch options → -c override bag (rendered by the host); key-shape guard.
  const opted = codexConnector.buildLaunch({
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
    () => codexConnector.buildLaunch({ space: "s", name: "n", launchOptions: { "a=b": "1" } }),
    /not a valid flag name/,
  );
  throws(
    "a prototype-polluting launch-option key is refused",
    () =>
      codexConnector.buildLaunch({
        space: "s",
        name: "n",
        launchOptions: JSON.parse('{"__proto__":"x"}') as Record<string, unknown>,
      }),
    /not a valid flag name/,
  );

  // ACL + capabilities env rail.
  const acl = codexConnector.buildLaunch({
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
  const full = codexConnector.buildLaunch({
    space: "s",
    name: "n",
    role: "coder",
    id: "UAID",
    lifecycleUid: "lc-1",
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
  // The broker URL is NOT one of them: it rides the launch material, so a suite or a tool this seat
  // runs cannot resolve its "default" broker out of an inherited variable and silently dial ours.
  check(
    "broker URL delivered by launch material, not by env",
    full.env?.COTAL_SERVERS === undefined && configFromEnv(full.env).servers === "nats://x:1",
  );

  // A prompt is trimmed on the way in, and a prompt with no text refuses the launch (never dropped).
  check(
    "prompt is trimmed",
    codexConnector.buildLaunch({ space: "s", name: "n", prompt: "  greet  " }).env?.COTAL_CODEX_PROMPT === "greet",
  );
  let emptyPromptRefused = false;
  try {
    codexConnector.buildLaunch({ space: "s", name: "n", prompt: "   " });
  } catch (e) {
    emptyPromptRefused = /empty/.test(String((e as Error).message));
  }
  check("an empty prompt refuses the launch", emptyPromptRefused);

  // User-mode auth rail + the one-identity-plane rule.
  const user = codexConnector.buildLaunch({
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
      codexConnector.buildLaunch({
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
    () => codexConnector.buildLaunch({ space: "s", name: "n", resume: "0199-abc" }),
    /resum/i,
  );
  throws(
    "the whole mcp_servers namespace is reserved (top-level table, the reachable shape)",
    () => codexConnector.buildLaunch({ space: "s", name: "n", launchOptions: { mcp_servers: '{ evil = { url = "http://x" } }' } }),
    /reserved/i,
  );
  throws(
    "tool-sharing is refused",
    () => codexConnector.buildLaunch({ space: "s", name: "n", mcpServers: { srv: { command: "x" } } }),
    /tool-sharing/,
  );
  // The TUI/headless choice is derived from the host's own stdout, and COTAL_CODEX_TUI overrides
  // it. The child's env is an ALLOW-LIST, so an override that is not forwarded BY NAME is
  // advertised and unreachable through the one path operators actually use.
  const noTui = codexConnector.buildLaunch({ space: "s", name: "n" });
  check("COTAL_CODEX_TUI is absent when the operator did not set it", noTui.env?.COTAL_CODEX_TUI === undefined);
  process.env.COTAL_CODEX_TUI = "0";
  try {
    const forced = codexConnector.buildLaunch({ space: "s", name: "n" });
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

  console.log(`\nCODEX ARGS SMOKE PASSED ✅  (${pass} checks)`);
} finally {
  delete process.env.SUPER_SECRET_LEAK_CANARY;
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
