import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
test("bridge preload writes directly to output before first native tool", () => {
  const root = mkdtempSync(join(tmpdir(), "run45-bridge-"));
  const output = join(root, "upload"), runtime = join(root, "runtime"), dist = join(runtime, "dist");
  mkdirSync(output); mkdirSync(dist, { recursive: true });
  const workspace = join(runtime, "node_modules/@cotal-ai/workspace/dist");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "index.js"), "export const resolveOnPath = () => null;\n");
  for (const file of ["windows-bridge-trace.mjs", "windows-peer-trace.mjs", "windows-install-tool-trace.mjs"]) copyFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), join(runtime, file));
  const entry = join(dist, "entry.mjs");
  writeFileSync(entry, `import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
if(!existsSync(join(process.env.COTAL_DESKTOP_E2E_TRACE_HOME,'native-tool-timings.jsonl'))) throw Error('missing early timing artifact');
spawnSync('whoami.exe',[]);
process.stdout.write(JSON.stringify({event:'setup-progress',stage:'fixture'})+'\\n');
`);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(join(runtime, "windows-bridge-trace.mjs")).href, entry, "daemon", "desktop"], {
    env: { ...process.env, COTAL_DESKTOP_E2E_TRACE_HOME: output }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = readFileSync(join(output, "windows-bridge-progress.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(row => row.phase), ["install-tool-start", "install-tool-end", "progress"]);
  assert.ok(rows.every(row => Number.isFinite(Date.parse(row.at))));
  assert.ok(!existsSync(join(runtime, "windows-bridge-progress.jsonl")));
});
