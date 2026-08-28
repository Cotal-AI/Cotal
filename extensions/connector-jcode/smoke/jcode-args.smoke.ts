import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, registry } from "@cotal-ai/core";
import { configFromEnv, controlFromEnv, cotalToolSpecs } from "@cotal-ai/connector-core";
import { z } from "zod";
import { jcodeConnector, listJcodeModels } from "../src/index.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  try {
    assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
};
const throws = (name: string, fn: () => unknown, match: RegExp): void => {
  try {
    assert.throws(fn, match, name);
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
};
const catalogRefusesWithoutHome = (name: string, home: string, fn: () => unknown, match: RegExp): void => {
  let message = "";
  try {
    fn();
  } catch (error) {
    message = (error as Error).message;
  }
  check(name, match.test(message) && !message.includes(home), message);
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
  check("declares a bounded three-minute bootstrap window", jcodeConnector.readinessTimeoutMs === 180_000, jcodeConnector.readinessTimeoutMs);
  check("feeds the declared catalog into the connector hook", jcodeConnector.listModels === listJcodeModels);
  const realJcodeHome = process.env.JCODE_HOME;
  const catalogHome = join(dir, "catalog-home");
  mkdirSync(catalogHome);
  writeFileSync(
    join(catalogHome, "config.toml"),
    `[providers.cliproxy]\nmodel_catalog = true\n\n[[providers.cliproxy.models]]\nid = "opus-5"\nreasoning_efforts = ["low", "max"]\n\n[[providers.cliproxy.models]]\nid = "plain"\n`,
  );
  process.env.JCODE_HOME = catalogHome;
  try {
    rmSync(join(catalogHome, "config.toml"));
    catalogRefusesWithoutHome("unreadable catalog failure hides the Jcode home", catalogHome, () => listJcodeModels(), /could not read Jcode config: unreadable \(ENOENT\)/);
    writeFileSync(join(catalogHome, "config.toml"), `this = [is not valid TOML`);
    catalogRefusesWithoutHome("malformed TOML failure hides the Jcode home", catalogHome, () => listJcodeModels(), /could not parse Jcode config: malformed TOML/);
    writeFileSync(join(catalogHome, "config.toml"), `unrelated = true\n`);
    catalogRefusesWithoutHome("missing providers failure hides the Jcode home", catalogHome, () => listJcodeModels(), /has no \[providers\] table/);
    writeFileSync(
      join(catalogHome, "config.toml"),
      `[providers.cliproxy]\nmodel_catalog = true\n\n[[providers.cliproxy.models]]\nid = "opus-5"\nreasoning_efforts = ["low", "max"]\n\n[[providers.cliproxy.models]]\nid = "plain"\n`,
    );
    const catalog = listJcodeModels();
    check("exposes Jcode's declared config catalog", catalog.models.map((m) => m.id).join(",") === "opus-5,plain", catalog);
    check("attributes every model to its declared provider", catalog.models.every((m) => m.provider === "cliproxy"), catalog);
    check("labels declared reasoning efforts as non-authoritative", catalog.models[0]?.variants?.map((v) => `${v.name}:${v.options?.authoritative}`).join(",") === "low:false,max:false", catalog.models[0]);
    check("names the declared config source without duplicating the per-tier caveat", catalog.source === "declared Jcode config", catalog.source);

    writeFileSync(join(catalogHome, "config.toml"), `[providers.cliproxy]\nmodel_catalog = false\n`);
    catalogRefusesWithoutHome("no enabled provider failure hides the Jcode home", catalogHome, () => listJcodeModels(), /no provider with model_catalog = true/);
    writeFileSync(join(catalogHome, "config.toml"), `[providers.cliproxy]\nmodel_catalog = true\n`);
    throws("fails loud when an enabled provider declares no model entries", () => listJcodeModels(), /has no \[\[providers\.cliproxy\.models\]\] entries/);
    writeFileSync(join(catalogHome, "config.toml"), `[providers.cliproxy]\nmodel_catalog = true\nmodels = []\n`);
    catalogRefusesWithoutHome("empty enabled catalog failure hides the Jcode home", catalogHome, () => listJcodeModels(), /enabled 1 provider\(s\).*declared no models/);
    writeFileSync(join(catalogHome, "config.toml"), `[providers.cliproxy]\nmodel_catalog = true\n[[providers.cliproxy.models]]\nid = "broken"\nreasoning_efforts = "high"\n`);
    throws("fails loud on malformed declared effort metadata", () => listJcodeModels(), /reasoning_efforts must be an array/);
  } finally {
    if (realJcodeHome === undefined) delete process.env.JCODE_HOME;
    else process.env.JCODE_HOME = realJcodeHome;
  }
  check("forwards mesh identity", base.env?.COTAL_SPACE === "space" && base.env?.COTAL_NAME === "seat");
  check("pins private state to the launch directory", base.env?.COTAL_JCODE_HOME === process.cwd());
  check("drops ordinary operator env unless explicitly allowed", base.env?.UNRELATED_JCODE_ENV_CANARY === undefined);
  const allowed = jcodeConnector.buildLaunch({ space: "space", name: "seat", envAllow: ["UNRELATED_JCODE_ENV_CANARY"] });
  check("inherits explicitly allowed operator env", allowed.env?.UNRELATED_JCODE_ENV_CANARY === "inherited");
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

  console.log(`\nJCODE ARGS SMOKE PASSED: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
} finally {
  delete process.env.UNRELATED_JCODE_ENV_CANARY;
  rmSync(dir, { recursive: true, force: true });
}
