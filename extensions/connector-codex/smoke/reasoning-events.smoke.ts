/**
 * A Codex launch with `reasoningEvents`, with no broker.
 *
 * The connector declares the field and hands it to the seat in its launch material. A seat that has
 * it asks Codex for reasoning summaries on every turn: the summary the operator's
 * `model_reasoning_summary` names, else `auto`, as T3 Code's own Codex provider sends on each
 * `turn/start`. A launch without it sends no summary and keeps Codex's own default. The shipped
 * driver runs against the scripted fake app-server.
 *
 * Run: pnpm smoke:codex-reasoning-events
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, type LaunchOpts } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { AppServerDriver } from "../src/app-server.js";
import * as codexConfig from "../src/codex-config.js";
import { codexConnector } from "../src/extension.js";

if (process.platform === "win32") skipSuite("managed Codex agents are POSIX-only");

const { check, finish } = createSuite();

check("the Codex connector declares supportsReasoningEvents", codexConnector.supportsReasoningEvents === true);
const material = (opts: Partial<LaunchOpts>) => {
  const userAuth = { owner: "o", actor: "a", sentinelCredsPath: "/tmp/sc", bearerCmd: ["cmd"] };
  const spec = codexConnector.buildLaunch({ space: "s", name: "n", events: true, workspaceRoot: tmpdir(), userAuth, ...opts });
  return readLaunchMaterial(spec.env?.[LAUNCH_MATERIAL_ENV] as string);
};
check("a reasoningEvents launch hands the field to the seat in its launch material", material({ reasoningEvents: true }).reasoningEvents === true);
check("a launch without it hands none", material({}).reasoningEvents === undefined);

const summary = (launchOptions?: Record<string, string>): unknown => {
  if (launchOptions) process.env.COTAL_CODEX_CONFIG = JSON.stringify(launchOptions);
  try {
    return codexConfig.reasoningTurn?.(codexConfig.configOverrides("gpt", undefined, false, undefined));
  } finally {
    delete process.env.COTAL_CODEX_CONFIG;
  }
};
check("a seat with it asks for summaries as auto", JSON.stringify(summary()) === JSON.stringify({ summary: "auto" }), summary());
check("an operator's model_reasoning_summary wins", JSON.stringify(summary({ model_reasoning_summary: '"detailed"' })) === JSON.stringify({ summary: "detailed" }), summary({ model_reasoning_summary: '"detailed"' }));

const dir = mkdtempSync(join(tmpdir(), "codex-reasoning-"));
const BIN = join(dir, "fake-codex");
writeFileSync(BIN, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("./fake-codex.mjs", import.meta.url))}" "$@"\n`);
chmodSync(BIN, 0o755);
const LOG = join(dir, "fake.log.jsonl");
process.env.FAKE_CODEX_LOG = LOG;

/** The `turn/start` params a driver with `turnSettings` sends for one turn `run` starts. */
async function turnStart(turnSettings: Record<string, unknown> | undefined, run: (d: AppServerDriver) => Promise<void>): Promise<Record<string, unknown> | undefined> {
  rmSync(LOG, { force: true });
  const opts: ConstructorParameters<typeof AppServerDriver>[0] = { cwd: dir, codexHome: dir, configOverrides: [], bin: BIN, turnSettings, log: () => {} };
  const driver = new AppServerDriver(opts);
  try {
    await driver.start();
    await run(driver);
  } finally {
    await driver.stop();
  }
  const entries = readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ev: string; method?: string; params?: Record<string, unknown> });
  return entries.find((e) => e.ev === "recv" && e.method === "turn/start")?.params;
}

try {
  const asked = await turnStart({ summary: "auto" }, (d) => d.startTurn("hello"));
  check("a seat with it sends the summary on turn/start", asked?.summary === "auto" && Array.isArray(asked.input), asked);
  const skill = await turnStart({ summary: "auto" }, (d) => d.startSkillTurn("review", join(dir, "SKILL.md"), ""));
  check("and on a skill's turn/start", skill?.summary === "auto", skill);
  const plain = await turnStart(undefined, (d) => d.startTurn("hello"));
  check("a seat without it sends no summary", plain !== undefined && !("summary" in plain), plain);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

finish();
