import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const root = mkdtempSync(join(tmpdir(), "cotal-fresh-guidance-"));
const home = join(root, "home");
const cwd = join(root, "project");
for (const dir of [home, cwd]) mkdirSync(dir, { mode: 0o700 });
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["FORCE_COLOR", "NO_COLOR"].includes(key))),
  HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "cotal"), XDG_CONFIG_HOME: join(home, "config"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
};
const bin = join(import.meta.dirname, "..", "dist", "cotal.js");
const { check, finish } = createSuite();
function cli(args: string[], status = 0): string {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}
const help = cli(["login", "--help"]);
check("login help names direct Cloud sign-in instead of a chooser", help.includes("sign in to Cotal Cloud and approve sign-in") && !help.includes("choose a provider"), help);
const spaces = cli(["space"]);
check("an empty space listing points at Cloud login", spaces.includes("cotal login"), spaces);
const use = cli(["use"]);
check("an empty fresh selection points at login", use.includes("`cotal login`"), use);
const preview = cli(["spawn", "--dry-run"], 2);
check("a fresh spawn preview refusal points at login and retains local alternatives", preview.includes("`cotal login`") && preview.includes("`cotal up`") && preview.includes("`--server`"), preview);
const status = cli(["status"]);
check("fresh status Next points at login", status.split("\nNext\n")[1]?.includes("cotal login") === true, status);
finish();
