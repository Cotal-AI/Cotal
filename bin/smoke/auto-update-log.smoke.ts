import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automaticUpdates } from "../daemon/auto-update.js";
const home=mkdtempSync(join(tmpdir(),"autoupd-log-"));
process.env.COTAL_HOME=home;
process.env.npm_config_registry="http://127.0.0.1:1";
const victim=join(home,"owned-target");writeFileSync(victim,"preserve-me");
symlinkSync(victim,join(home,"update-attempt.log"));
writeFileSync(join(home,"update-attempt.json"),JSON.stringify({version:"99.0.0",failures:0,result:"due",next:0}));
writeFileSync(join(home,"update-check.json"),JSON.stringify({v:1,latest:"99.0.0",attemptedAt:Date.now(),checkedAt:Date.now(),firstSeenAt:Date.now()-3601000}));
const updater=automaticUpdates({version:"1.0.0",eligible:()=>true,prepare:async()=>{},abort:async()=>{},report:()=>{}});
try {
 await new Promise(resolve=>setTimeout(resolve,31000));
 assert.equal(readFileSync(victim,"utf8"),"preserve-me","updater must refuse a symlink log without overwriting its target");
 emitSentinel({ passed: counted.cells(), failed: 0 });
} finally { await updater.close(); }
