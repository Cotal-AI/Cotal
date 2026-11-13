import "../../implementations/cli/smoke/update-isolation.js";
import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
} finally { await updater.close(); }
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let mac: ReturnType<typeof automaticUpdates> | undefined;
try {
 Object.defineProperty(process, "platform", { value: "darwin" });
 writeFileSync(join(home,"update-attempt.json"),JSON.stringify({version:"99.0.0",failures:0,result:"due",next:0}));
 mac = automaticUpdates({version:"1.0.0",eligible:()=>true,prepare:async()=>{},abort:async()=>{},report:()=>{}});
 await new Promise(resolve=>setTimeout(resolve,31000));
 const result = JSON.parse(readFileSync(join(home,"update-attempt.json"),"utf8"));
 assert.match(result.result, /launchd automatic update handoff refused: .*Run `cotal update --self`/);
 assert.match(mac.status().lastResult, /launchd automatic update handoff refused/);
 assert.equal(readFileSync(victim,"utf8"),"preserve-me","failed native handoff must never fall back to child installation");
 emitSentinel({ passed: counted.cells(), failed: 0 });
} finally { await mac?.close(); Object.defineProperty(process,"platform",platform); rmSync(home, { recursive: true, force: true }); }
