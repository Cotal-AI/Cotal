import "./update-isolation.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const root = mkdtempSync(join(tmpdir(), "auto-seed-selection-"));
const entry = join(root, "prefix/lib/node_modules/cotal-ai/dist/cotal.js");
mkdirSync(join(entry, ".."), { recursive: true, mode: 0o700 });
writeFileSync(entry, "// installed entry\n");
writeFileSync(join(entry, "../..", "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.166.0", bin: { cotal: "./dist/cotal.js" } }));
const guard = pathToFileURL(join(import.meta.dirname, "../src/seed/manager-guard.ts")).href;
let passed = 0;
for (const scenario of ["selected", "canonical", "invalid"] as const) {
  const home = join(root, scenario);
  mkdirSync(join(home, "config/cotal/seed"), { recursive: true, mode: 0o700 });
  const script = `
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
${scenario === "canonical" ? "" : "import {join,dirname} from 'node:path';"}
import {connectorConfigDir,retainConnectorConfig} from '@cotal-ai/workspace';
${scenario === "canonical" ? "" : `Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:${JSON.stringify(entry)},loadedEntry:${JSON.stringify(entry)}})});`}
const {assertAutomaticSeedManagers}=await import(${JSON.stringify(guard)});
const canonical=connectorConfigDir();
${scenario === "canonical" ? `await assert.rejects(assertAutomaticSeedManagers('0.166.0'), /cannot resolve the cotal entry script/, 'canonical guard must still inspect its installation rather than skip custody');` : `const selected=retainConnectorConfig();assert.notEqual(selected,canonical);${scenario === "invalid" ? `writeFileSync(join(dirname(selected),'selection.json'),JSON.stringify({v:1,entry:'forged',version:'0.166.0',root:selected}));await assert.rejects(assertAutomaticSeedManagers('0.166.0'),/differs/,'invalid selection must not bypass custody');` : `await assertAutomaticSeedManagers('0.166.0');assert.equal(connectorConfigDir(),selected);`}`}
`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  Object.assign(env, { COTAL_HOME: join(home, "cotal"), HOME: home, XDG_CONFIG_HOME: join(home, "config") });
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: join(import.meta.dirname, ".."), env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${scenario}: ${result.stdout}${result.stderr}`);
  passed++;
}
emitSentinel({ passed, failed: 0 });
