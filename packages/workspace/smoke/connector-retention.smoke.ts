import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const root = mkdtempSync(join(tmpdir(), "connector-retention-"));
const installed = join(root, "prefix/lib/node_modules/cotal-ai");
const entry = join(installed, "dist/cotal.js");
mkdirSync(join(installed, "dist"), { recursive: true, mode: 0o700 });
writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.165.4", bin: { cotal: "./dist/cotal.js" } }));
writeFileSync(entry, "// installed fixture\n");
const module = pathToFileURL(join(import.meta.dirname, "../src/connector-retention.ts")).href;
let passed = 0;
try {
  for (const scenario of ["retain", "no-identity", "invalid-selection", "linked-prefix", "linked-parent", "stage-root", "next-version"] as const) {
    const config = join(root, scenario);
    mkdirSync(join(config, "cotal/seed/store/0.162.0"), { recursive: true, mode: 0o700 });
    mkdirSync(join(config, "cotal/extensions/node_modules/old"), { recursive: true, mode: 0o700 });
    writeFileSync(join(config, "cotal/seed/stamp.json"), JSON.stringify({ generation: "0.162.0" }));
    writeFileSync(join(config, "cotal/extensions/node_modules/old/lazy.js"), "old graph\n");
    const script = `
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,symlinkSync,renameSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
${scenario === "no-identity" ? "" : `Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:${JSON.stringify(entry)},loadedEntry:${JSON.stringify(entry)}})});`}
const {connectorConfigDir,retainConnectorConfig}=await import(${JSON.stringify(module)});
const original=${JSON.stringify(join(config, "cotal"))};
assert.equal(connectorConfigDir(),original);
${scenario === "no-identity" ? `assert.throws(()=>retainConnectorConfig(),/installed POSIX/);` : scenario === "linked-prefix" ? `renameSync(join(original,'extensions'),join(original,'foreign'));symlinkSync(join(original,'foreign'),join(original,'extensions'));assert.throws(()=>retainConnectorConfig(),/non-directory/);` : `
const selected=retainConnectorConfig();
assert.notEqual(selected,original);
assert.equal(connectorConfigDir(),selected);
assert.equal(retainConnectorConfig(),selected);
assert.equal(readFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'utf8'),'old graph\\n');
writeFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'new graph\\n');
assert.equal(readFileSync(join(original,'extensions/node_modules/old/lazy.js'),'utf8'),'old graph\\n');
assert.equal(readFileSync(join(original,'seed/stamp.json'),'utf8'),JSON.stringify({generation:'0.162.0'}));
${scenario === "invalid-selection" ? `const record=join(dirname(selected),'selection.json');writeFileSync(record,JSON.stringify({v:1,entry:'wrong',version:'0.165.4',root:selected}),{mode:0o600});assert.throws(()=>connectorConfigDir(),/differs/);` : ""}
${scenario === "linked-parent" ? `const parent=dirname(dirname(dirname(selected))),outside=join(original,'moved-install');renameSync(parent,outside);symlinkSync(outside,parent);assert.throws(()=>connectorConfigDir(),/private|link/);` : ""}
${scenario === "stage-root" ? `const stage=join(original,'.extensions.stage-fixture','config');mkdirSync(join(stage,'cotal/extensions'),{recursive:true,mode:0o700});process.env.XDG_CONFIG_HOME=stage;assert.equal(connectorConfigDir(),join(stage,'cotal'));` : ""}
${scenario === "next-version" ? `writeFileSync(${JSON.stringify(join(installed, "package.json"))},JSON.stringify({name:'cotal-ai',version:'0.165.5',bin:{cotal:'./dist/cotal.js'}}));const next=retainConnectorConfig();assert.notEqual(next,selected);assert.equal(readFileSync(join(next,'extensions/node_modules/old/lazy.js'),'utf8'),'new graph\\n');assert.equal(readFileSync(join(original,'extensions/node_modules/old/lazy.js'),'utf8'),'old graph\\n');` : ""}
`}
console.log('PASS');
`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, XDG_CONFIG_HOME: config, COTAL_HOME: join(config, "home") }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${scenario}: ${result.stdout}${result.stderr}`);
    passed++;
  }
  console.log("connector retention: original graph preserved, selected copy isolated, unsupported and forged state refused");
  emitSentinel({ passed, failed: 0 });
} finally { rmSync(root, { recursive: true, force: true }); }
