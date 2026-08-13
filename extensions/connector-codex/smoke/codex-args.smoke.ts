/**
 * Codex connector buildLaunch smoke (pure, no broker, no binary): the LaunchOpts → LaunchSpec
 * rendering and every declared fail-loud edge. Run: pnpm smoke:codex-args
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "@cotal-ai/core";
import { codexConnector } from "../src/index.js";
// connector-core by SOURCE path — see the parity cell below for why dist would be vacuous.
import { eventChannel as coreEventChannel } from "../../connector-core/src/launch.js";

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
  check(
    "control endpoint in env, matching the spec",
    base.env?.COTAL_CONTROL_SOCKET === base.control?.path && base.env?.COTAL_CONTROL_TOKEN === base.control?.token,
  );
  check("codex data root defaults to the launch dir", base.env?.COTAL_CODEX_HOME === process.cwd());
  check("env allow-list: unrelated operator env is NOT forwarded", base.env?.SUPER_SECRET_LEAK_CANARY === undefined);
  check("env allow-list: the provider key IS forwarded by name", base.env?.OPENAI_API_KEY === "sk-test-canary");
  check("no transcript by default", base.env?.COTAL_EVENTS === undefined);

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
    events: true,
    prompt: "greet the operator",
  });
  check(
    "role/id/lifecycle/servers/transcript/prompt forwarded",
    full.env?.COTAL_ROLE === "coder" &&
      full.env?.COTAL_ID === "UAID" &&
      full.env?.COTAL_LIFECYCLE_UID === "lc-1" &&
      full.env?.COTAL_SERVERS === "nats://x:1" &&
      full.env?.COTAL_EVENTS === "1" &&
      full.env?.COTAL_CODEX_PROMPT === "greet the operator",
  );

  // User-mode auth rail + the one-identity-plane rule.
  const user = codexConnector.buildLaunch({
    space: "s",
    name: "n",
    userAuth: { owner: "o", actor: "a", sentinelCredsPath: "/tmp/sc", bearerCmd: ["cmd", "arg"] },
  });
  check(
    "user-mode auth rail forwarded",
    user.env?.COTAL_OWNER === "o" && user.env?.COTAL_ACTOR === "a" && user.env?.COTAL_BEARER_CMD === '["cmd","arg"]',
  );
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
  // PARITY, not correctness. This cell exists to catch connector-codex growing its OWN copy of the
  // mapping; whether the mapping itself is right is `smoke:event-channel`'s job, beside the function.
  //
  // The reference is connector-core's SOURCE, deliberately. `codexConnector.eventChannel` arrives
  // through `@cotal-ai/connector-core`, i.e. that package's `dist/` — so comparing it against a
  // package-name import of the same thing would compare a value with itself and pass no matter what
  // either side did. Against the source it also reddens on a stale `dist/`, which is a real skew.
  //
  // A hardcoded literal was what it asserted before, and the literal went stale the moment the
  // channel mapping gained its collision suffix: the suite was red on the CI gate while the lane's
  // own focused suites were green. Pinning behaviour to a constant copied out of the implementation
  // is why. Found by fmae-rev-test, fmae-rev-eng and fmae-rev-wal.
  for (const name of ["My Agent", "worker", "Worker", "worker-a67b04cd5c491d4d"]) {
    check(
      `event channel convention shared with connector-core (${JSON.stringify(name)})`,
      codexConnector.eventChannel?.(name) === coreEventChannel(name),
      { codex: codexConnector.eventChannel?.(name), core: coreEventChannel(name) },
    );
  }
  // Non-vacuity: the two cells above would also pass if BOTH sides returned a constant. The mapping
  // must actually distinguish the names it is given.
  check(
    "the shared mapping is a real mapping, not a constant",
    new Set(["My Agent", "worker", "Worker"].map((n) => codexConnector.eventChannel?.(n))).size === 3,
    ["My Agent", "worker", "Worker"].map((n) => codexConnector.eventChannel?.(n)),
  );

  console.log(`\nCODEX ARGS SMOKE PASSED ✅  (${pass} checks)`);
} finally {
  delete process.env.SUPER_SECRET_LEAK_CANARY;
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
