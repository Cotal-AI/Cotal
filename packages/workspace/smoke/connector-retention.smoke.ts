import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
// Each scenario child gets its own private COTAL_HOME, so no ambient Cotal identity may reach it.
const childEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith("COTAL_")) delete childEnv[key];
let passed = 0;
try {
  const freshConfig = join(root, "fresh");
  mkdirSync(freshConfig, { mode: 0o700 });
  const fresh = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:${JSON.stringify(entry)},loadedEntry:${JSON.stringify(entry)}})});
const {connectorConfigDir,inheritConnectorConfig}=await import(${JSON.stringify(module)});
const before=connectorConfigDir();
assert(before.endsWith('/sets/0.165.4/cotal') && before.includes('/installs/'));
assert.equal(existsSync(before),false,'root reads must not create retained state');
assert.deepEqual(readdirSync(process.env.XDG_CONFIG_HOME),[],'fresh root reads must not create config files');
const {chmodSync,mkdirSync,statSync}=await import('node:fs');
const {prepareConnectorConfigForUpdate}=await import(${JSON.stringify(module)});
mkdirSync(before+'/seed',{recursive:true,mode:0o700});
chmodSync(before+'/seed',0o500);
chmodSync(before,0o500);
prepareConnectorConfigForUpdate();
assert.equal(statSync(before+'/seed').mode&0o777,0o700,'unfinished seed directory can be replaced later');
inheritConnectorConfig();
assert.equal(connectorConfigDir(),before,'initial inheritance keeps the advertised root');
assert.equal(existsSync(before),true);
`], { env: { ...childEnv, XDG_CONFIG_HOME: freshConfig, COTAL_HOME: join(root, "fresh-home") }, encoding: "utf8", timeout: 30_000 });
  assert.equal(fresh.status, 0, `${fresh.stdout}${fresh.stderr}`);
  passed++;
  for (const scenario of ["unfinished-root", "unfinished-holders", "unfinished-seat", "unfinished-live-seat", "unfinished-dead-seat", "unfinished-link", "unselected-holder", "seat-holder", "unknown-set", "unknown-seat", "previous-read", "previous-wrong-entry", "previous-wrong-root", "previous-wrong-version", "previous-linked-ancestor", "previous-nonprivate-ancestor", "retain", "linked-config", "pnpm-dlx-refresh", "no-identity", "invalid-selection", "linked-prefix", "linked-parent", "stage-root", "next-version", "live-holder", "removal-failure", "orphan-child", "interrupted-lineage", "initial-inherit", "checkout", "desktop", "windows"] as const) {
    const config = join(root, scenario);
    mkdirSync(join(config, "cotal/seed/store/0.162.0"), { recursive: true, mode: 0o700 });
    mkdirSync(join(config, "cotal/extensions/node_modules/old"), { recursive: true, mode: 0o700 });
    writeFileSync(join(config, "cotal/seed/stamp.json"), JSON.stringify({ generation: "0.162.0" }));
    writeFileSync(join(config, "cotal/extensions/node_modules/old/lazy.js"), "old graph\n");
    if (scenario === "linked-config") {
      renameSync(config, `${config}-physical`);
      symlinkSync(`${config}-physical`, config);
    }
    const script = `
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,symlinkSync,renameSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
${scenario === "checkout" ? `const checkout=${JSON.stringify(join(config, "checkout"))};mkdirSync(join(checkout,'bin/dist'),{recursive:true,mode:0o700});mkdirSync(join(checkout,'implementations'),{mode:0o700});writeFileSync(join(checkout,'bin/package.json'),JSON.stringify({name:'cotal-ai',version:'0.166.0',bin:{cotal:'./dist/cotal.js'}}));writeFileSync(join(checkout,'bin/dist/cotal.js'),'');Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:join(checkout,'bin/dist/cotal.js'),loadedEntry:join(checkout,'bin/dist/cotal.js')})});` : scenario === "pnpm-dlx-refresh" ? `const dlxA=${JSON.stringify(join(config, "cache/pnpm/dlx/f366da99/mwm2iwjx-ygzp/node_modules/.pnpm/cotal-ai@0.165.4/node_modules/cotal-ai"))},dlxB=${JSON.stringify(join(config, "cache/pnpm/dlx/f366da99/mwm2kdsm-z19x/node_modules/.pnpm/cotal-ai@0.165.4/node_modules/cotal-ai"))};for(const dir of [dlxA,dlxB]){mkdirSync(join(dir,'dist'),{recursive:true,mode:0o700});writeFileSync(join(dir,'package.json'),JSON.stringify({name:'cotal-ai',version:'0.165.4',bin:{cotal:'./dist/cotal.js'}}));writeFileSync(join(dir,'dist/cotal.js'),'// dlx fixture\\n');}let currentDlx=join(dlxA,'dist/cotal.js');Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{get(){return Object.freeze({logicalEntry:currentDlx,loadedEntry:currentDlx});}});` : scenario === "no-identity" ? "" : `Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:${JSON.stringify(entry)},loadedEntry:${JSON.stringify(entry)}})});`}
${scenario === "desktop" ? `writeFileSync(${JSON.stringify(join(installed, "desktop-runtime.json"))},'{}');` : scenario === "windows" ? `Object.defineProperty(process,'platform',{value:'win32'});` : ""}
const {connectorConfigDir,retainConnectorConfig,inheritConnectorConfig,canRecoverConnectorConfig,prepareConnectorConfigForUpdate}=await import(${JSON.stringify(module)});
const original=${JSON.stringify(join(config, "cotal"))};
const metadata=${JSON.stringify(join(installed, "package.json"))};
writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.4',bin:{cotal:'./dist/cotal.js'}}));
// Access time is excluded because reading bytes may update it on relatime filesystems.
function snapshot(path){const result=[];function visit(file,relative){const stat=fs.lstatSync(file,{bigint:true});result.push({path:relative,mode:String(stat.mode),uid:String(stat.uid),gid:String(stat.gid),ino:String(stat.ino),dev:String(stat.dev),nlink:String(stat.nlink),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs),birthtimeNs:String(stat.birthtimeNs),sha256:stat.isFile()?createHash('sha256').update(readFileSync(file)).digest('hex'):undefined,link:stat.isSymbolicLink()?fs.readlinkSync(file):undefined});if(stat.isDirectory())for(const name of fs.readdirSync(file).sort())visit(join(file,name),join(relative,name));}visit(path,'.');return result;}
const canonicalBefore=snapshot(original);
assert.equal(connectorConfigDir(),original);
assert.equal(canRecoverConnectorConfig(),true,'canonical state keeps implicit recovery');
assert.deepEqual(snapshot(original),canonicalBefore,'no predecessor must read canonical state without writes');
${scenario === "initial-inherit" ? "inheritConnectorConfig();assert.notEqual(connectorConfigDir(),original,'first installed seed must select without existing lineage');" : ""}
${scenario === "no-identity" || scenario === "checkout" || scenario === "desktop" || scenario === "windows" ? `inheritConnectorConfig();assert.equal(connectorConfigDir(),original);assert.throws(()=>retainConnectorConfig(),/installed POSIX/);` : scenario === "linked-prefix" ? `renameSync(join(original,'extensions'),join(original,'foreign'));symlinkSync(join(original,'foreign'),join(original,'extensions'));assert.throws(()=>retainConnectorConfig(),/non-directory/);` : `
${scenario === "linked-config" ? `const parent=mkdtempSync(join(${JSON.stringify(root)},'replaceable-link-parent-'));symlinkSync(process.env.XDG_CONFIG_HOME,join(parent,'config'));const safe=process.env.XDG_CONFIG_HOME;process.env.XDG_CONFIG_HOME=join(parent,'config');fs.chmodSync(parent,0o777);assert.throws(()=>retainConnectorConfig(),/replaceable-link-parent.*writable/);assert.equal(fs.existsSync(join(original,'installs')),false,'refused link parent publishes no retained state');fs.chmodSync(parent,0o700);process.env.XDG_CONFIG_HOME=safe;` : ""}
${scenario === "interrupted-lineage" ? `const rename=fs.renameSync;let publications=0;fs.renameSync=(source,target)=>{if(/(?:selection|current)\\.json$/.test(String(target))&&++publications===2)throw new Error('interrupted second publication');return rename(source,target)};syncBuiltinESMExports();assert.throws(()=>retainConnectorConfig(),/interrupted second publication/);fs.renameSync=rename;syncBuiltinESMExports();const selected=connectorConfigDir();assert.notEqual(selected,original);` : "const selected=retainConnectorConfig();"}
assert.notEqual(selected,original);
assert.equal(connectorConfigDir(),selected);
assert.equal(canRecoverConnectorConfig(),true,'current selection, including interrupted publication, keeps recovery');
assert.equal(retainConnectorConfig(),selected);
${scenario === "retain" ? `const unrelated=join(original,'installs','other-install');mkdirSync(unrelated,{mode:0o500});fs.chmodSync(selected,0o520);fs.chmodSync(join(selected,'seed'),0o500);prepareConnectorConfigForUpdate();assert.equal(connectorConfigDir(),selected);assert.equal(fs.statSync(selected).mode&0o777,0o700);assert.equal(fs.statSync(join(selected,'seed')).mode&0o777,0o700);assert.equal(fs.statSync(unrelated).mode&0o777,0o500);fs.chmodSync(unrelated,0o700);` : ""}
assert.equal(readFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'utf8'),'old graph\\n');
writeFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'new graph\\n');
assert.equal(readFileSync(join(original,'extensions/node_modules/old/lazy.js'),'utf8'),'old graph\\n');
assert.equal(readFileSync(join(original,'seed/stamp.json'),'utf8'),JSON.stringify({generation:'0.162.0'}));
${scenario === "pnpm-dlx-refresh" ? `currentDlx=join(dlxB,'dist/cotal.js');assert.equal(connectorConfigDir(),selected,'refreshed pnpm dlx cache instance reuses the retained connector directory');assert.equal(retainConnectorConfig(),selected,'refreshed pnpm dlx cache instance does not create a second retained tree');assert.equal(fs.readdirSync(join(original,'installs')).length,1,'pnpm dlx cache refresh keeps one installs/<key> directory');` : ""}
${scenario === "unselected-holder" ? `const {retainConnectorSeat,pruneRetainedConnectorConfig}=await import(${JSON.stringify(module)});const before=snapshot(dirname(selected));writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.5',bin:{cotal:'./dist/cotal.js'}}));assert.equal(connectorConfigDir(),selected,'unselected version reads predecessor');const holder=retainConnectorSeat('manager-B','worker');assert.equal(holder.active,false,'unselected version must not reserve a holder');holder.launched(process.pid);holder.ended();pruneRetainedConnectorConfig([]);assert.deepEqual(snapshot(dirname(selected)),before,'unselected version neither writes predecessor nor prunes');assert.equal(fs.existsSync(join(dirname(dirname(selected)),'0.165.5')),false,'unselected version creates no set');` : ""}
${scenario === "seat-holder" ? `const {retainConnectorSeat,pruneRetainedConnectorConfig}=await import(${JSON.stringify(module)});const {launchSeat,reapSeat,identityVerdict}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../../seat/dist/index.js")).href)});const custody=join(process.env.HOME,'custody-${scenario}');const holder=retainConnectorSeat('manager-A','worker');const rec=launchSeat({root:custody,name:'worker',cwd:process.env.HOME,spec:{command:process.execPath,args:['-e','setInterval(()=>{},1000)']}});holder.launched(rec.childPid);try{writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.5',bin:{cotal:'./dist/cotal.js'}}));retainConnectorConfig();pruneRetainedConnectorConfig(['0.165.5']);assert(fs.existsSync(join(selected,'extensions/node_modules/old/lazy.js')),'orphan seat keeps its plugin');assert.equal(identityVerdict(rec.childPid,rec.childStart,rec.bootId),'live');await reapSeat(custody,rec.id);pruneRetainedConnectorConfig(['0.165.5']);assert(!fs.existsSync(selected),'dead custody identity releases its set without Manager cleanup');}finally{await reapSeat(custody,rec.id);}` : ""}
${scenario === "unknown-set" || scenario === "unknown-seat" ? `const {retainConnectorSeat,pruneRetainedConnectorConfig}=await import(${JSON.stringify(module)});${scenario === "unknown-set" ? "rmSync(join(dirname(selected),'holders-v1.json'));" : "const holder=retainConnectorSeat('manager-A','worker');holder.launched();"}writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.5',bin:{cotal:'./dist/cotal.js'}}));retainConnectorConfig();pruneRetainedConnectorConfig(['0.165.5']);assert(fs.existsSync(selected),'unknown provenance keeps the old set');${scenario === "unknown-seat" ? "holder.ended();pruneRetainedConnectorConfig(['0.165.5']);assert(!fs.existsSync(selected),'only the owning Manager releases an identity-less holder');" : ""}` : ""}
${scenario === "live-holder" ? `const {pruneRetainedConnectorConfig}=await import(${JSON.stringify(module)});const {homeCotalDir}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/cotal-home.ts")).href)});mkdirSync(join(homeCotalDir(),'daemon'),{recursive:true,mode:0o700});writeFileSync(join(homeCotalDir(),'daemon/daemon.lock'),JSON.stringify({v:1,pid:process.pid}),{mode:0o600});writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.5',bin:{cotal:'./dist/cotal.js'}}));const next=retainConnectorConfig();assert(fs.existsSync(selected),'live unversioned daemon preserves every set');pruneRetainedConnectorConfig(['0.165.4']);assert(fs.existsSync(selected),'authenticated older holder keeps its set');pruneRetainedConnectorConfig([undefined]);assert(fs.existsSync(selected),'unknown holder keeps every set');pruneRetainedConnectorConfig(['0.165.5']);assert(!fs.existsSync(selected),'older set retires once all authenticated holders use current');assert.equal(connectorConfigDir(),next);` : ""}
${scenario === "removal-failure" ? `const remove=fs.rmSync;fs.rmSync=(path,options)=>{if(String(path)===dirname(selected))throw new Error('collection denied');return remove(path,options)};syncBuiltinESMExports();try{writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.5',bin:{cotal:'./dist/cotal.js'}}));const next=retainConnectorConfig();assert.equal(connectorConfigDir(),next);assert(fs.existsSync(selected),'failed removal retains earlier set without failing publication');assert.equal(readFileSync(join(next,'extensions/node_modules/old/lazy.js'),'utf8'),'new graph\\n');}finally{fs.rmSync=remove;syncBuiltinESMExports();}` : ""}
${scenario === "invalid-selection" ? `const record=join(dirname(selected),'selection.json');writeFileSync(record,JSON.stringify({v:1,entry:'wrong',version:'0.165.4',root:selected}),{mode:0o600});assert.throws(()=>connectorConfigDir(),/differs/);` : ""}
${scenario === "linked-parent" ? `const parent=dirname(dirname(dirname(selected))),outside=join(original,'moved-install');renameSync(parent,outside);symlinkSync(outside,parent);assert.throws(()=>connectorConfigDir(),/private|link/);` : ""}
${scenario === "stage-root" ? `const stage=join(original,'.extensions.stage-fixture','config');mkdirSync(join(stage,'cotal/extensions'),{recursive:true,mode:0o700});process.env.XDG_CONFIG_HOME=stage;assert.equal(connectorConfigDir(),join(stage,'cotal'));` : ""}
${scenario.startsWith("previous-") ? `const predecessorHolder=(await import(${JSON.stringify(module)})).retainConnectorSeat('predecessor-manager','worker');const sets=dirname(dirname(selected));const currentRecord=join(sets,'current.json');const oldMetadata=readFileSync(metadata);const oldRecord=JSON.parse(readFileSync(currentRecord,'utf8'));const nextVersion='0.165.5';const nextPath=join(sets,nextVersion);writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:nextVersion,bin:{cotal:'./dist/cotal.js'}}));assert.equal(fs.existsSync(nextPath),false,'new generation has no selection or directory');assert.equal(oldRecord.root,selected,'current still names predecessor');
${scenario === "previous-read" ? `const before=snapshot(original);const metadataBefore=snapshot(metadata);for(let read=0;read<3;read++){assert.equal(connectorConfigDir(),selected,'read must use predecessor before inheritance');assert.equal(canRecoverConnectorConfig(),false,'read-only predecessor must not receive implicit recovery');assert.deepEqual(snapshot(original),before,'repeated predecessor reads must not create files or modify config metadata');assert.deepEqual(snapshot(metadata),metadataBefore,'repeated reads must not modify installed metadata');}assert.equal(fs.existsSync(nextPath),false,'read must not create the new version directory');const contents=path=>snapshot(path).map(({path,mode,uid,gid,sha256,link})=>({path,mode,uid,gid,sha256,link}));symlinkSync('lazy.js',join(selected,'extensions/node_modules/old/lazy-link.js'));const oldState=contents(selected);const oldSelection=readFileSync(join(dirname(selected),'selection.json'),'utf8');inheritConnectorConfig();const next=connectorConfigDir();assert.equal(next,join(nextPath,'cotal'));assert.notEqual(next,selected,'inheritance must select a distinct copy');assert.deepEqual(JSON.parse(readFileSync(join(nextPath,'selection.json'),'utf8')),{v:1,entry:oldRecord.entry,version:nextVersion,root:next},'inheritance must publish the new current-version selection');assert.deepEqual(JSON.parse(readFileSync(currentRecord,'utf8')),{v:1,entry:oldRecord.entry,version:nextVersion,root:next},'inheritance must advance current lineage');assert.equal(readFileSync(join(dirname(selected),'selection.json'),'utf8'),oldSelection,'predecessor selection bytes must remain unchanged');assert.equal(fs.readlinkSync(join(next,'extensions/node_modules/old/lazy-link.js')),'lazy.js','inherited link must preserve its target');assert.deepEqual(contents(selected),oldState,'inheritance must leave predecessor contents and permissions unchanged');assert.equal(readFileSync(join(next,'extensions/node_modules/old/lazy.js'),'utf8'),'new graph\\n');writeFileSync(join(next,'extensions/node_modules/old/lazy.js'),'next graph\\n');assert.equal(readFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'utf8'),'new graph\\n','new copy must not alias predecessor');` : scenario === "previous-wrong-entry" ? `writeFileSync(currentRecord,JSON.stringify({...oldRecord,entry:'wrong'}));assert.throws(()=>connectorConfigDir(),/invalid previous/,'wrong predecessor entry must not fall back to canonical');` : scenario === "previous-wrong-root" ? `writeFileSync(currentRecord,JSON.stringify({...oldRecord,root:original}));assert.throws(()=>connectorConfigDir(),/invalid previous/,'wrong predecessor root must not fall back to canonical');` : scenario === "previous-wrong-version" ? `writeFileSync(currentRecord,JSON.stringify({...oldRecord,version:'../0.165.4'}));assert.throws(()=>connectorConfigDir(),/invalid previous/,'malformed predecessor version must not fall back to canonical');` : scenario === "previous-nonprivate-ancestor" ? `fs.chmodSync(dirname(selected),0o755);assert.throws(()=>connectorConfigDir(),/private/,'nonprivate predecessor ancestor must not fall back to canonical');` : `const ancestor=dirname(selected),outside=join(original,'linked-predecessor');renameSync(ancestor,outside);symlinkSync(outside,ancestor);assert.throws(()=>connectorConfigDir(),/private|link/,'linked predecessor ancestor must not fall back to canonical');`}
writeFileSync(metadata,oldMetadata);` : ""}
${scenario.startsWith("unfinished-") ? `const sets=dirname(dirname(selected));const nextPath=join(sets,'0.165.5');const nextRoot=join(nextPath,'cotal');const before=snapshot(selected).map(({path,mode,uid,gid,sha256,link})=>({path,mode,uid,gid,sha256,link}));const currentBefore=readFileSync(join(sets,'current.json'),'utf8');mkdirSync(nextPath,{mode:0o700});${scenario === "unfinished-link" ? "symlinkSync(selected,nextRoot);" : "fs.cpSync(selected,nextRoot,{recursive:true});fs.chmodSync(nextRoot,0o700);writeFileSync(join(nextRoot,'abandoned'),'not published');"}${scenario !== "unfinished-root" && scenario !== "unfinished-link" ? `mkdirSync(join(nextPath,'holders'),{mode:0o700});writeFileSync(join(nextPath,'holders-v1.json'),'{"v":1}\\n',{mode:0o600});` : ""}${scenario === "unfinished-seat" || scenario === "unfinished-live-seat" || scenario === "unfinished-dead-seat" ? `writeFileSync(join(nextPath,'holders/seat.json'),JSON.stringify({v:1,manager:'manager',agent:'worker',${scenario === "unfinished-dead-seat" ? "custody:{pid:spawnSync(process.execPath,['-e','']).pid,start:'old',boot:'previous-boot'}" : scenario === "unfinished-live-seat" ? `custody:{pid:process.pid,start:(await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/advisory-lock.ts")).href)})).processStartToken(process.pid),boot:process.platform==='linux'?readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim():'unknown-boot'}` : ""}}),{mode:0o600});` : ""}writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.5',bin:{cotal:'./dist/cotal.js'}}));${scenario === "unfinished-seat" || scenario === "unfinished-live-seat" || scenario === "unfinished-link" ? `assert.throws(()=>retainConnectorConfig(),/holders|private/);assert.equal(readFileSync(join(sets,'current.json'),'utf8'),currentBefore);assert.equal(fs.existsSync(join(nextPath,'selection.json')),false);` : `const next=retainConnectorConfig();assert.equal(next,nextRoot);assert.equal(connectorConfigDir(),nextRoot);assert.equal(fs.existsSync(join(nextRoot,'abandoned')),false,'unpublished copy is recreated');assert.equal(readFileSync(join(nextRoot,'extensions/node_modules/old/lazy.js'),'utf8'),'new graph\\n');assert.equal(retainConnectorConfig(),nextRoot,'retry keeps the published copy');assert.deepEqual(JSON.parse(readFileSync(join(nextPath,'selection.json'),'utf8')).root,nextRoot);`}assert.deepEqual(snapshot(selected).map(({path,mode,uid,gid,sha256,link})=>({path,mode,uid,gid,sha256,link})),before,'predecessor contents and permissions remain unchanged');` : ""}
${scenario === "next-version" ? `
writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.5',bin:{cotal:'./dist/cotal.js'}}));
const next=retainConnectorConfig();
assert.notEqual(next,selected);
assert(fs.existsSync(selected),'publishing a generation does not collect an earlier set without an authenticated holder inventory');
const {pruneRetainedConnectorConfig}=await import(${JSON.stringify(module)});
pruneRetainedConnectorConfig([undefined]);
assert(fs.existsSync(selected),'unknown foreign holder vetoes collection');
const {writeUpdateRecovery,clearUpdateRecovery}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/updates.ts")).href)});
const {claimUpdateClosureAccess,updateClosureOwner}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/update-closure.ts")).href)});
const rollback=join(selected,'.update-snapshot-rollback');
mkdirSync(rollback,{mode:0o700});
writeFileSync(join(rollback,'stamp'),'rollback data');
const idle=join(dirname(dirname(selected)),'0.165.3');
mkdirSync(join(idle,'holders'),{recursive:true,mode:0o700});
writeFileSync(join(idle,'holders-v1.json'),'{"v":1}\\n',{mode:0o600});
const release=claimUpdateClosureAccess();
try {
  const rollbackRecord={previous:'0.165.4',target:'0.165.5',installed:'0.165.5',phase:'verified-ready',owner:updateClosureOwner(),reason:'final verification pending'};
  writeUpdateRecovery({...rollbackRecord,snapshot:rollback});
  pruneRetainedConnectorConfig([]);
  assert(fs.existsSync(rollback),'collection must keep the rollback snapshot until final verification');
  assert(!fs.existsSync(idle),'the pending rollback does not pin an unrelated idle set');
  const retryRoot=join(dirname(selected),'cotal-0123456789abcdef');
  mkdirSync(retryRoot,{mode:0o700});
  const retryRollback=join(retryRoot,'.update-snapshot-rollback');
  renameSync(rollback,retryRollback);
  writeUpdateRecovery({...rollbackRecord,snapshot:retryRollback});
  pruneRetainedConnectorConfig([]);
  assert.equal(readFileSync(join(retryRollback,'stamp'),'utf8'),'rollback data','collection must retain a snapshot in a suffixed connector root');
  assert.equal(readFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'utf8'),'new graph\\n');
  rmSync(retryRollback,{recursive:true});
} finally { try { clearUpdateRecovery(); } finally { release(); } }
pruneRetainedConnectorConfig([]);
assert(!fs.existsSync(selected),'authenticated idle inventory collects earlier release after commit');
assert.equal(readFileSync(join(next,'extensions/node_modules/old/lazy.js'),'utf8'),'new graph\\n');
assert.equal(readFileSync(join(original,'extensions/node_modules/old/lazy.js'),'utf8'),'old graph\\n');
` : ""}
${scenario === "interrupted-lineage" ? `const {homeCotalDir}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/cotal-home.ts")).href)});mkdirSync(join(homeCotalDir(),'daemon'),{recursive:true,mode:0o700});writeFileSync(join(homeCotalDir(),'daemon/daemon.lock'),JSON.stringify({v:1,pid:process.pid}),{mode:0o600});const originalMeta=readFileSync(${JSON.stringify(join(installed, "package.json"))});writeFileSync(${JSON.stringify(join(installed, "package.json"))},JSON.stringify({name:'cotal-ai',version:'0.165.6',bin:{cotal:'./dist/cotal.js'}}));const next=retainConnectorConfig();assert.equal(readFileSync(join(next,'extensions/node_modules/old/lazy.js'),'utf8'),'new graph\\n','published selection must remain source when lineage publication was interrupted');writeFileSync(${JSON.stringify(join(installed, "package.json"))},originalMeta);assert.equal(connectorConfigDir(),selected,'advancing lineage must leave interrupted older version selected');` : ""}
${scenario === "orphan-child" ? `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});try{const wrapperEnv={...process.env};for(const key of Object.keys(wrapperEnv))if(key.startsWith('COTAL_'))delete wrapperEnv[key];const wrapper=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',${JSON.stringify(`import {beginExtensionNpmMutation} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/extension-mutation.ts")).href)};beginExtensionNpmMutation().markLive(Number(process.env.MARKED_CHILD));`)}],{env:{...wrapperEnv,XDG_CONFIG_HOME:dirname(selected),MARKED_CHILD:String(child.pid)},encoding:'utf8'});assert.equal(wrapper.status,0,wrapper.stderr);writeFileSync(${JSON.stringify(join(installed, "package.json"))},JSON.stringify({name:'cotal-ai',version:'0.165.7',bin:{cotal:'./dist/cotal.js'}}));assert.throws(()=>retainConnectorConfig(),/still running|mutation/,'live orphan marker must block source copy even with free locks');}finally{rmSync(join(selected,'.extensions.lock.npm-child'),{force:true});child.kill('SIGTERM');await new Promise(done=>child.once('exit',done));}` : ""}
`}
console.log('PASS');
`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...childEnv, XDG_CONFIG_HOME: config, COTAL_HOME: join(config, "home") }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${scenario}: ${result.stdout}${result.stderr}`);
    passed++;
  }
  rmSync(join(installed, "desktop-runtime.json"), { force: true });
  for (const source of ["canonical", "retained", "linked-retained"] as const) {
    const config = join(root, `update-${source}`);
    mkdirSync(join(config, "cotal/seed"), { recursive: true, mode: 0o700 });
    mkdirSync(join(config, "cotal/extensions"), { mode: 0o700 });
    if (source === "linked-retained") {
      renameSync(config, `${config}-physical`);
      symlinkSync(`${config}-physical`, config);
    }
    const childScript = `
import assert from 'node:assert/strict';
import {chmodSync,readFileSync,mkdirSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';
Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:${JSON.stringify(entry)},loadedEntry:${JSON.stringify(entry)}})});
const {connectorConfigDir,inheritConnectorConfig,prepareConnectorConfigForUpdate}=await import(${JSON.stringify(module)});
assert.equal(connectorConfigDir(),process.env.SNAPSHOT,'reconciliation reads the updater snapshot, not the stale target');
const staleExtensions=join(process.env.STALE,'extensions');
chmodSync(staleExtensions,0o500);
prepareConnectorConfigForUpdate();
assert.equal(statSync(staleExtensions).mode&0o777,0o500,'snapshot preflight leaves the stale target untouched');
const configHome=process.env.XDG_CONFIG_HOME;
const stage=join(dirname(process.env.STALE),'.extensions.stage-fixture','config');
mkdirSync(join(stage,'cotal/extensions'),{recursive:true,mode:0o700});
process.env.XDG_CONFIG_HOME=stage;
assert.equal(connectorConfigDir(),join(stage,'cotal'),'extension validation must keep its private stage');
process.env.XDG_CONFIG_HOME=configHome;
inheritConnectorConfig();
const selected=connectorConfigDir();
assert.notEqual(selected,process.env.STALE);
assert.equal(readFileSync(join(selected,'extensions/state'),'utf8'),'tmux added; pi removed');
assert.equal(readFileSync(join(process.env.STALE,'extensions/state'),'utf8'),'pi installed');
const selectedExtensions=join(selected,'extensions');
chmodSync(selectedExtensions,0o500);
prepareConnectorConfigForUpdate();
assert.equal(statSync(selectedExtensions).mode&0o777,0o700,'preflight repairs the newly selected root');
chmodSync(staleExtensions,0o700);
inheritConnectorConfig();
assert.equal(connectorConfigDir(),selected,'one transaction inherits only once');
`;
    const script = `
import assert from 'node:assert/strict';
import {cpSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:${JSON.stringify(entry)},loadedEntry:${JSON.stringify(entry)}})});
const {retainConnectorConfig,connectorConfigDir}=await import(${JSON.stringify(module)});
const {claimUpdateClosureAccess,updateClosureChildEnv,updateClosureOwner}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/update-closure.ts")).href)});
const {writeUpdateRecovery,clearUpdateRecovery}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/updates.ts")).href)});
const metadata=${JSON.stringify(join(installed, "package.json"))};
writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.4',bin:{cotal:'./dist/cotal.js'}}));
const stale=retainConnectorConfig();
writeFileSync(join(stale,'extensions/state'),'pi installed');
const current=${source === "canonical" ? JSON.stringify(join(config, "cotal")) : "stale"};
const snapshot=mkdtempSync(join(current,'.update-snapshot-'));
cpSync(join(current,'extensions'),join(snapshot,'extensions'),{recursive:true});
writeFileSync(join(snapshot,'extensions/state'),'tmux added; pi removed');
const release=claimUpdateClosureAccess();
try {
writeUpdateRecovery({previous:'0.166.0',target:'0.165.4',installed:'0.166.0',phase:'replacing',reason:'test update',owner:updateClosureOwner(),snapshot});
const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',${JSON.stringify(childScript)}],{env:{...updateClosureChildEnv(process.env),COTAL_UPDATE_PARENT:String(process.pid),SNAPSHOT:snapshot,STALE:stale},encoding:'utf8'});
assert.equal(child.status,0,child.stdout+child.stderr);
clearUpdateRecovery();
const selected=connectorConfigDir();
assert.notEqual(selected,stale,'completed update keeps its new selection');
assert.equal(readFileSync(join(selected,'extensions/state'),'utf8'),'tmux added; pi removed');
} finally { release(); }
`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...childEnv, XDG_CONFIG_HOME: config, COTAL_HOME: join(config, "home") }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `update-${source}: ${result.stdout}${result.stderr}`);
    passed++;
  }
  console.log("connector retention: original graph preserved, selected copy isolated, unsupported and forged state refused");
  emitSentinel({ passed, failed: 0 });
} finally { rmSync(root, { recursive: true, force: true }); }
