import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("debug wrapper writes before entry and manager traces stay outside runtime home", () => {
  const root = mkdtempSync(join(tmpdir(), "run45-trace-"));
  const output = join(root, "upload"), runtime = join(root, "runtime");
  mkdirSync(output); mkdirSync(runtime);
  const childEntry = join(runtime, "child.mjs");
  writeFileSync(childEntry, "export {};\n");
  const entry = join(runtime, "entry.mjs");
  writeFileSync(entry, `import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
if (!existsSync(join(process.env.COTAL_DESKTOP_E2E_TRACE_HOME,'native-tool-timings.jsonl'))) throw Error('trace missing before first native call');
const child=spawnSync(process.execPath,[...process.execArgv,${JSON.stringify(childEntry)}, '__machine-manager'],{env:process.env});
if(child.status!==0) throw Error(String(child.stderr));
`);
  const wrapper = join(runtime, "windows-native-trace.mjs");
  for (const file of ["windows-native-trace.mjs", "windows-manager-path.mjs"]) {
    copyFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), join(runtime, file));
  }
  const result = spawnSync(process.execPath, [wrapper, entry, "daemon", "serve"], {
    env: { ...process.env, COTAL_DESKTOP_E2E_TRACE_HOME: output }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const managerRows = readFileSync(join(output, "manager-path.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(managerRows.length, 1);
  assert.equal(managerRows[0].path, process.env.PATH ?? "");
  assert.ok(!existsSync(join(runtime, "manager-path.jsonl")));
  assert.ok(existsSync(join(output, "native-tool-timings.jsonl")));
  assert.ok(!existsSync(join(runtime, "native-tool-timings.jsonl")));
  assert.ok(readFileSync(join(output, "native-tool-timings.jsonl"), "utf8").includes('wrapper-start'));
});
