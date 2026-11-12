import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("native debug wrapper carries a read-only PATH probe into only the hosted Manager", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-manager-path-"));
  try {
    for (const file of ["windows-native-trace.mjs", "windows-manager-path.mjs"]) {
      copyFileSync(fileURLToPath(new URL(`../e2e/${file}`, import.meta.url)), join(root, file));
    }
    const child = join(root, "child.mjs");
    writeFileSync(child, "process.stdout.write(JSON.stringify({pid:process.pid,path:process.env.PATH}));\n");
    const entry = join(root, "entry.mjs");
    writeFileSync(entry, `import {spawnSync} from 'node:child_process';
const child=spawnSync(process.execPath,[...process.execArgv,${JSON.stringify(child)},'__machine-manager'],{env:process.env,encoding:'utf8'});
if(child.status!==0) throw new Error(child.stderr);
process.stdout.write(child.stdout);
`);
    const result = spawnSync(process.execPath, [join(root, "windows-native-trace.mjs"), entry, "daemon", "serve"], {
      encoding: "utf8", env: { ...process.env, COTAL_TEST_UNRELATED: "must-not-be-recorded" }, timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const childProcess = JSON.parse(result.stdout);
    const rows = readFileSync(join(root, "manager-path.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.length, 1, "the native daemon itself is not a Manager PATH record");
    assert.equal(rows[0].pid, childProcess.pid);
    assert.equal(rows[0].path, childProcess.path);
    assert.equal(rows[0].path, process.env.PATH ?? "");
    assert.deepEqual(Object.keys(rows[0]).sort(), ["at", "parentPid", "path", "pathExt", "pid"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
