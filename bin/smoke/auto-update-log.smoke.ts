import "../../implementations/cli/smoke/update-isolation.js";
import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
// A daemon loaded from a retained generation starts the updater at the installed entry, and an
// updater that ends without recording an outcome is counted and reported.
const prefix = realpathSync(mkdtempSync(join(tmpdir(), "autoupd-entry-")));
const entry = (root: string, body: string) => {
 mkdirSync(join(root, "dist"), { recursive: true });
 writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "./dist/cotal.js" } }));
 writeFileSync(join(root, "dist", "cotal.js"), body);
 return join(root, "dist", "cotal.js");
};
const startedInstalled = join(home, "started-installed"), startedGeneration = join(home, "started-generation");
const identity = Symbol.for("cotal.execution.identity");
Reflect.set(globalThis, identity, Object.freeze({
 logicalEntry: entry(join(prefix, "lib/node_modules/cotal-ai"), `require("node:fs").writeFileSync(${JSON.stringify(startedInstalled)}, process.argv.slice(2).join(" ")); console.error("refused here"); process.exit(3);`),
 loadedEntry: entry(join(prefix, "lib/.cotal-generations", "0".repeat(32), "cotal-ai"), `require("node:fs").writeFileSync(${JSON.stringify(startedGeneration)}, "");`),
}));
rmSync(join(home, "update-attempt.log"));
writeFileSync(join(home,"update-attempt.json"),JSON.stringify({version:"99.0.0",failures:0,result:"due",next:0}));
let eligibility: true | "pending" = "pending";
let preparations = 0;
const staged = automaticUpdates({version:"1.0.0",eligible:()=>eligibility,prepare:async()=>{ preparations++; },abort:async()=>{},report:()=>{}});
try {
 assert.equal(staged.status().automatic, true, "a due update is reported as enabled while verification runs");
 await new Promise(resolve=>setTimeout(resolve,31000));
 assert.equal(preparations, 0, "pending ownership does not admit a due update");
 assert.equal(existsSync(startedInstalled), false, "pending ownership does not launch the updater");
 eligibility = true;
 await new Promise(resolve=>setTimeout(resolve,33000));
 assert.equal(readFileSync(startedInstalled, "utf8"), "update --self", "the updater starts at the installed entry");
 assert.equal(existsSync(startedGeneration), false, "the retained generation's own bootstrap is not started");
 const ended = JSON.parse(readFileSync(join(home,"update-attempt.json"),"utf8"));
 assert.match(ended.result, /^updater ended with 3: refused here$/);
 assert.equal(ended.failures, 1, "an updater that records no outcome counts as a failure");
} finally { await staged.close(); Reflect.deleteProperty(globalThis, identity); rmSync(prefix, { recursive: true, force: true }); }
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
 await mac.close();
 writeFileSync(join(home,"update-launchd-result.json"),"{unreadable",{mode:0o600});
 mac = automaticUpdates({version:"1.0.0",eligible:()=>true,prepare:async()=>{},abort:async()=>{},report:()=>{}});
 assert.equal(mac.updating(),true,"unknown retained custody fences activation immediately on startup");
 await new Promise(resolve=>setTimeout(resolve,31000));
 assert.equal(mac.updating(),true,"unreadable custody remains fenced after scheduler observation fails");
 assert.match(mac.status().lastResult,/custody unresolved: .*retrying observation automatically/);
 emitSentinel({ passed: counted.cells(), failed: 0 });
} finally { await mac?.close(); Object.defineProperty(process,"platform",platform); rmSync(home, { recursive: true, force: true }); }
