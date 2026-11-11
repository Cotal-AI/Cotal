import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root=mkdtempSync(join(tmpdir(),"autoupd-doctor-"));const home=join(root,"home");mkdirSync(home);mkdirSync(join(root,".cotal"));
const env:NodeJS.ProcessEnv={...process.env,HOME:home,COTAL_HOME:home,XDG_CONFIG_HOME:join(root,"config"),npm_config_prefix:join(root,"prefix"),npm_config_cache:join(root,"cache"),npm_config_registry:"http://127.0.0.1:1",COTAL_SKIP_CONNECTOR_SEED:"1",COTAL_NO_UPDATE_CHECK:"1"};
const entry=fileURLToPath(new URL("../dist/cotal.js",import.meta.url));
for(const latest of ["99.0.0","0.0.0"]){
 writeFileSync(join(home,"update-check.json"),JSON.stringify({v:1,latest,checkedAt:Date.now(),attemptedAt:Date.now()}));
 const expected=latest==="99.0.0"?"newer version 99.0.0 available":"up to date";
 const report=spawnSync(process.execPath,[entry,"doctor","auth","--json"],{cwd:root,env,encoding:"utf8"});
 const doc=JSON.parse(report.stdout);assert.equal(doc.result.update,expected,report.stderr);
 const human=spawnSync(process.execPath,[entry,"doctor","auth"],{cwd:root,env,encoding:"utf8"});assert.ok(human.stdout.includes(expected),human.stdout+human.stderr);
}
emitSentinel({ passed: counted.cells(), failed: 0 });
