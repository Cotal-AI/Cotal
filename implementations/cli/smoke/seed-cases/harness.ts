import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, posix, win32 } from "node:path";
import { defaultAgentType } from "@cotal-ai/workspace";
import { isPathSpec } from "../../src/commands/ext.js";
import { seedGeneration, seedStorePath } from "../../src/seed/paths.js";
import { stageSeedPayload } from "../../src/seed/store.js";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const cleanup: string[] = [];
const track = <T extends string>(c: T): T => (cleanup.push(c), c);

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}
// The harness itself may run inside a supervised seat whose environment carries operational
// COTAL_* state — COTAL_SKIP_CONNECTOR_SEED in particular suppresses the very auto-seed under
// test — so the CLI under test always gets a COTAL_*-scrubbed base env. Cells that need a
// COTAL_* var (the forged-marker cells) inject it deliberately on top.
const initialCwd = process.cwd();
const privateHome = track(mkdtempSync(join(tmpdir(), "seed-home-")));
const HOST_ENV: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")),
);
for (const [key, name] of Object.entries({
  HOME: "home", COTAL_HOME: "cotal", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache", XDG_RUNTIME_DIR: "run", TMPDIR: "tmp",
})) {
  const dir = join(privateHome, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOST_ENV[key] = dir;
}
// The runner resolves tsx from the checkout, but CLI children must not discover
// a project or mesh through that checkout's ancestors.
process.chdir(privateHome);
function cotal(cfg: string, args: string[], extraEnv: Record<string, string> = {}): Run {
  const r = spawnSync("node", [BIN, ...args], {
    encoding: "utf8",
    env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1", ...extraEnv },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function fakeCotal(path: string, version: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' 'cotal-ai ${version}'\n`);
  chmodSync(path, 0o755);
}
const freshCfg = (): string => mkdtempSync(join(tmpdir(), "cotal-seed-smoke-"));
const seedDir = (cfg: string) => join(cfg, "cotal", "seed");
const manifestPath = (cfg: string) => join(cfg, "cotal", "extensions", "extensions.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
const listNames = (cfg: string): string[] => {
  const out = cotal(cfg, ["ext", "list"]).stdout;
  return ["claude", "opencode", "codex", "hermes", "jcode", "pi"].filter((n) => out.includes(`connector:${n}`));
};

export { spawn, spawnSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, tmpdir, delimiter, dirname, join, posix, win32, defaultAgentType, isPathSpec, seedGeneration, seedStorePath, stageSeedPayload, REPO, BIN, check, HOST_ENV, cotal, fakeCotal, freshCfg, seedDir, manifestPath, readJson, writeJson, listNames, track };

export function counts(): { passed: number; failed: number } {
  return { passed: pass, failed: fail };
}

export function cleanupScenario(): void {
  process.chdir(initialCwd);
  const errors: unknown[] = [];
  for (const dir of cleanup) {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "seed scenario cleanup failed");
}

export function finishScenario(): void {
  cleanupScenario();
  console.log(`seed case: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
