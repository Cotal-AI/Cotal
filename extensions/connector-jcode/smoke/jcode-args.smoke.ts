import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, registry } from "@cotal-ai/core";
import { configFromEnv, controlFromEnv, cotalToolSpecs } from "@cotal-ai/connector-core";
import { z } from "zod";
import { jcodeConnector } from "../src/index.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const throws = (name: string, fn: () => unknown, match: RegExp): void => {
  assert.throws(fn, match, name);
  pass++;
  console.log(`  ✓ ${name}`);
};

const dir = mkdtempSync(join(tmpdir(), "cotal-jcodeargs-"));
process.env.UNRELATED_JCODE_ENV_CANARY = "inherited";
try {
  let registered = false;
  try {
    registered = registry.resolve("connector", "jcode") === jcodeConnector;
  } catch {
    // Keep the assertion's named failure visible: a missing registration otherwise throws before
    // check() can print its label, which makes mutation-proof correctly call it an unrelated red.
  }
  check("self-registers as connector jcode", registered);
  if (process.platform === "win32") {
    // The refusal below is the FIRST buildLaunch on this platform: every later probe in this file
    // assumes a Unix host, so the Windows arm must run before any of them can throw unlabelled.
    throws("refuses unsupported Windows host", () => jcodeConnector.buildLaunch({ space: "s", name: "n" }), /not supported on Windows/);
    console.log(`\nJCODE ARGS SMOKE PASSED (${pass} checks)`);
    process.exit(0);
  }
  const base = jcodeConnector.buildLaunch({ space: "space", name: "seat" });
  check("starts the host entry", base.args.length === 1 && /host/.test(base.args[0]), base.args);
  check("requires the jcode binary", jcodeConnector.requires?.join(",") === "jcode");
  check("forwards mesh identity", base.env?.COTAL_SPACE === "space" && base.env?.COTAL_NAME === "seat");
  check("pins private state to the launch directory", base.env?.COTAL_JCODE_HOME === process.cwd());
  check("inherits ordinary operator env", base.env?.UNRELATED_JCODE_ENV_CANARY === "inherited");
  check("resets inherited Cotal material", base.env?.COTAL_CREDS === undefined && base.env?.COTAL_LIFECYCLE_UID === undefined);
  check("mints a manager control endpoint", Boolean(base.control?.path && base.control?.token));
  check("keeps the control token out of the environment", base.env?.COTAL_CONTROL_TOKEN === undefined);
  check("control token round-trips through launch material", controlFromEnv(base.env)?.token === base.control?.token);

  const rooted = jcodeConnector.buildLaunch({ space: "space", name: "seat", workspaceRoot: dir });
  check("workspaceRoot pins private state", rooted.env?.COTAL_JCODE_HOME === dir);
  check("Jcode TUI override is absent when unset", base.env?.COTAL_JCODE_TUI === undefined);
  process.env.COTAL_JCODE_TUI = "0";
  try {
    check("Jcode TUI override crosses the launch boundary", jcodeConnector.buildLaunch({ space: "s", name: "n" }).env?.COTAL_JCODE_TUI === "0");
  } finally {
    delete process.env.COTAL_JCODE_TUI;
  }

  const full = jcodeConnector.buildLaunch({
    space: "space",
    name: "seat",
    role: "worker",
    id: "ID",
    lifecycleUid: "life",
    servers: "nats://bridge.test:4222",
    model: "gpt-5.6-sol",
    prompt: "  do the thing  ",
  });
  check(
    "forwards identity/model/prompt",
    full.env?.COTAL_ROLE === "worker" &&
      full.env?.COTAL_ID === "ID" &&
      full.env?.COTAL_LIFECYCLE_UID === "life" &&
      full.env?.COTAL_MODEL === "gpt-5.6-sol" &&
      full.env?.COTAL_JCODE_PROMPT === "do the thing",
    full.env,
  );
  check("keeps broker URL out of env", full.env?.COTAL_SERVERS === undefined);
  check("broker URL resolves from material", configFromEnv(full.env).servers === "nats://bridge.test:4222");
  check("material preserves static creds when supplied", (() => {
    const withCreds = jcodeConnector.buildLaunch({ space: "s", name: "n", creds: "/tmp/seat.creds" });
    return readLaunchMaterial(withCreds.env?.[LAUNCH_MATERIAL_ENV] ?? "").creds === "/tmp/seat.creds";
  })());

  const persona = join(dir, "agent.md");
  writeFileSync(persona, "---\nname: seat\nmodel: from-file\nvariant: medium\n---\nPersona\n");
  check("uses agent-file model as a default", jcodeConnector.buildLaunch({ space: "s", name: "seat", configPath: persona }).env?.COTAL_MODEL === "from-file");
  check("explicit model wins over agent file", jcodeConnector.buildLaunch({ space: "s", name: "seat", configPath: persona, model: "flag" }).env?.COTAL_MODEL === "flag");

  // The variant IS Jcode's per-session reasoning effort. The connector carries the requested tier
  // verbatim; the tier is validated at launch by the provider that owns the ladder (the host calls
  // set_reasoning_effort and lets Jcode refuse), so nothing here re-implements that catalog.
  check("variant support is declared", jcodeConnector.supportsModelVariant === true);
  const tiered = jcodeConnector.buildLaunch({ space: "space", name: "seat", model: "gpt-5.6-sol", variant: "xhigh" });
  check("variant rides env as the reasoning effort", tiered.env?.COTAL_VARIANT === "xhigh", tiered.env);
  check("variant reaches the host config seam", configFromEnv(tiered.env).variant === "xhigh");
  check("variant is absent when unrequested", base.env?.COTAL_VARIANT === undefined);
  check("uses agent-file variant as a default", jcodeConnector.buildLaunch({ space: "s", name: "seat", configPath: persona }).env?.COTAL_VARIANT === "medium");
  check("explicit variant wins over agent file", jcodeConnector.buildLaunch({ space: "s", name: "seat", configPath: persona, variant: "max" }).env?.COTAL_VARIANT === "max");

  // Jcode decorates its MCP calls with these two harness fields. The bridge extends only the
  // advertised host schema and strips them before relaying; arbitrary Cotal inputs remain closed.
  const hostSchema = cotalToolSpecs(configFromEnv(full.env), "jcode").find((spec) => spec.name === "cotal_dm")!.schema
    .extend({ accept_large_output: z.boolean().optional(), intent: z.string().optional() }).strict();
  check("Jcode MCP decoration is accepted by the host-facing schema", hostSchema.safeParse({ to: "operator", text: "PONG", accept_large_output: false, intent: "reply" }).success);
  check("Jcode MCP schema still refuses non-harness extras", !hostSchema.safeParse({ to: "operator", text: "PONG", owner: "forged" }).success);

  throws("refuses empty prompt", () => jcodeConnector.buildLaunch({ space: "s", name: "n", prompt: "  " }), /empty/);
  throws("refuses resume", () => jcodeConnector.buildLaunch({ space: "s", name: "n", resume: "old" }), /resum/i);
  throws("refuses exact-session continuation", () => jcodeConnector.buildLaunch({ space: "s", name: "n", continueSession: "old" }), /continuation/);
  throws("refuses an empty variant", () => jcodeConnector.buildLaunch({ space: "s", name: "n", variant: "  " }), /empty/);
  throws("refuses tool sharing", () => jcodeConnector.buildLaunch({ space: "s", name: "n", mcpServers: { extra: { command: "x" } } }), /tool-sharing/);
  throws("refuses unsupported launch options", () => jcodeConnector.buildLaunch({ space: "s", name: "n", launchOptions: { profile: "full" } }), /launch options are not supported/);
  throws("still validates malformed launch option keys", () => jcodeConnector.buildLaunch({ space: "s", name: "n", launchOptions: { "a=b": "x" } }), /not a valid flag name/);

  console.log(`\nJCODE ARGS SMOKE PASSED (${pass} checks)`);
} finally {
  delete process.env.UNRELATED_JCODE_ENV_CANARY;
  rmSync(dir, { recursive: true, force: true });
}
