import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
test('diagnostic timeout preserves live output and logs before failing',()=>{
 const root=mkdtempSync(join(tmpdir(),'duration-deadline-'));
 const sample=join(root,'update-duration-1');mkdirSync(sample);
 writeFileSync(join(sample,'daemon.log'),'fixture daemon log');
 const child=join(root,'child.mjs');writeFileSync(child,'console.log("fixture started");setInterval(()=>{},1000);');
 const result=spawnSync(process.execPath,[resolve('scripts/update-duration-diagnostic.mjs'),child],{env:{...process.env,RUNNER_ENVIRONMENT:'github-hosted',RUNNER_TEMP:root,SAMPLE:'1',UPDATE_DIAGNOSTIC_TIMEOUT_MS:'500'},encoding:'utf8',timeout:10000});
 assert.equal(result.status,1,result.stderr);
 const evidence=join(root,'update-duration-evidence');
 assert.match(readFileSync(join(evidence,'measure-live.log'),'utf8'),/fixture started/);
 assert(existsSync(join(evidence,'timeout-processes.txt')));
 assert.match(readFileSync(join(evidence,'timeout-update-daemon-logs.json'),'utf8'),/fixture daemon log/);
 assert.equal(JSON.parse(readFileSync(join(evidence,'measure-exit.json'))).timedOut,true);
});
