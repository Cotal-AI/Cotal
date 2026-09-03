import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "../src/commands/status.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const realArgv1 = process.argv[1];
const realCwd = process.cwd();
const realLog = console.log;
const sandbox = mkdtempSync(join(tmpdir(), "cotal-status-provenance-"));
const project = join(sandbox, "project");
const installedRoot = join(sandbox, "installed", "cotal-ai");
const installedEntry = join(installedRoot, "dist", "cotal.js");
const installedShim = join(sandbox, "bin", "cotal");
const sourceEntry = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
const sourceRoot = realpathSync(join(import.meta.dirname, "..", "..", ".."));
const sourceVersion = (JSON.parse(readFileSync(join(sourceRoot, "bin", "package.json"), "utf8")) as { version: string }).version;
const pluginVersion = "8.8.8";

mkdirSync(join(project, ".cotal"), { recursive: true });
mkdirSync(join(installedRoot, "dist"), { recursive: true });
mkdirSync(join(sandbox, "bin"), { recursive: true });
writeFileSync(join(installedRoot, "package.json"), JSON.stringify({ name: "cotal-ai", version: "9.9.9" }));
writeFileSync(installedEntry, "// installed-entry fixture\n");
symlinkSync(installedEntry, installedShim);
const claude = join(sandbox, "bin", "claude");
writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' '[{"id":"cotal-skills@cotal-mesh","scope":"user","enabled":true,"version":"${pluginVersion}"}]'\n`);
chmodSync(claude, 0o755);
process.env.COTAL_HOME = join(sandbox, "home");
process.env.XDG_CONFIG_HOME = join(sandbox, "xdg");
process.env.PATH = join(sandbox, "bin");
process.chdir(project);

async function statusText(entry: string): Promise<string> {
  process.argv[1] = entry;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await status({ values: {}, positionals: [], raw: [] });
  } finally {
    console.log = realLog;
  }
  return lines.join("\n").replace(ANSI, "");
}

let pass = 0;
let fail = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    pass++;
    realLog(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

try {
  await check("source status names the source checkout root", async () => {
    const out = await statusText(sourceEntry);
    assert.match(out, new RegExp(`cotal-ai\\s+v${escapeRegex(sourceVersion)} \\(source checkout: ${escapeRegex(sourceRoot)}\\)`));
    assert.match(out, new RegExp(`Claude skills\\s+v${pluginVersion} ≠ v${escapeRegex(sourceVersion)} · stale`));
  });

  await check("installed status names the installed package root", async () => {
    const out = await statusText(installedShim);
    assert.match(out, new RegExp(`cotal-ai\\s+v9\\.9\\.9 \\(installed: ${escapeRegex(realpathSync(installedRoot))}\\)`));
    assert.match(out, new RegExp(`Claude skills\\s+v${pluginVersion} ≠ v9\\.9\\.9 · stale`));
  });
} finally {
  process.argv[1] = realArgv1;
  process.chdir(realCwd);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

realLog(`\nSTATUS PROVENANCE SMOKE COMPLETE: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
