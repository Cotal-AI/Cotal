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
  const repair = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
import assert from 'node:assert/strict';
import {chmodSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:${JSON.stringify(entry)},loadedEntry:${JSON.stringify(entry)}})});
const {connectorConfigDir,retainConnectorConfig,repairConnectorSelection,pruneRetainedConnectorConfig}=await import(${JSON.stringify(module)});
const old = retainConnectorConfig();
const keep = join(old, 'keep');
writeFileSync(keep, 'preserved');
const selections = [join(dirname(old), 'selection.json'), join(dirname(dirname(old)), 'current.json')];
const corrupt = ['{"v":2}', '{bad json'];
for (const [i, file] of selections.entries()) { writeFileSync(file, corrupt[i]); chmodSync(file, 0o400); }
assert.throws(() => repairConnectorSelection(() => { throw new Error('source check refused'); }), /source check refused/);
for (const [i, file] of selections.entries()) assert.equal(readFileSync(file, 'utf8'), corrupt[i]);
const retained = repairConnectorSelection(() => {});
const repaired = connectorConfigDir();
assert.notEqual(repaired, old);
assert.equal(readFileSync(keep, 'utf8'), 'preserved');
assert.equal(retained.length, 2);
for (const [i, file] of selections.entries()) {
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).root, repaired);
  const folder = dirname(file), name = file.slice(folder.length + 1);
  const backups = readdirSync(folder).filter(file => file.startsWith(name + '.corrupt.'));
  assert.equal(backups.length, 1);
  const backup = join(folder, backups[0]);
  assert(retained.includes(backup));
  assert.equal(readFileSync(backup, 'utf8'), corrupt[i]);
  assert.equal(statSync(backup).mode & 0o777, 0o400);
}
const metadata = ${JSON.stringify(join(installed, "package.json"))};
const previous = readFileSync(metadata);
try {
  writeFileSync(metadata, JSON.stringify({ ...JSON.parse(previous), version: '0.165.5' }));
  retainConnectorConfig();
  pruneRetainedConnectorConfig([]);
  for (const [i, backup] of retained.entries()) assert.equal(readFileSync(backup, 'utf8'), corrupt[i]);
} finally { writeFileSync(metadata, previous); }
`], { env: { ...childEnv, XDG_CONFIG_HOME: join(root, "repair-config"), COTAL_HOME: join(root, "repair-home") }, encoding: "utf8", timeout: 30_000 });
  assert.equal(repair.status, 0, `${repair.stdout}${repair.stderr}`);
  passed++;
  for (const scenario of ["unfinished-root", "unfinished-holders", "unfinished-seat", "unfinished-live-seat", "unfinished-dead-seat", "unfinished-link", "unselected-holder", "shared-holder", "seat-holder", "unknown-set", "unknown-seat", "previous-read", "previous-wrong-entry", "previous-wrong-root", "previous-wrong-version", "previous-linked-ancestor", "previous-nonprivate-ancestor", "retain", "linked-config", "moved-config", "pnpm-dlx-refresh", "no-identity", "invalid-selection", "linked-prefix", "linked-parent", "stage-root", "next-version", "live-holder", "removal-failure", "orphan-child", "interrupted-lineage", "interrupted-canonical-move", "interrupted-canonical-cleanup", "initial-inherit", "checkout", "desktop", "windows"] as const) {
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
function assertRootPermissionRefusal(path) {
  if (process.getuid?.()===0) return;
  const ino=fs.lstatSync(path).ino, chmod=fs.chmodSync;
  fs.chmodSync(path,0o200);
  try {
    assert.throws(()=>connectorConfigDir(),error=>error.code==='EACCES' && !error.message.includes('restore it there from a backup'));
    fs.chmodSync=(target,mode)=>{if(fs.lstatSync(target,{throwIfNoEntry:false})?.ino===ino)throw Object.assign(new Error('read-only filesystem'),{code:'EROFS'});return chmod(target,mode);};
    syncBuiltinESMExports();
    assert.throws(()=>prepareConnectorConfigForUpdate(),error=>error.code==='PERMISSION_DENIED' && error.remedy.includes('owned and writable') && error.remedy.includes('read and search') && error.native?.outcome==='not-executed' && !error.message.includes('restore it there from a backup'));
    fs.chmodSync=chmod;
    syncBuiltinESMExports();
    fs.chmodSync(path,0);
    prepareConnectorConfigForUpdate();
    assert.equal(fs.statSync(path).mode&0o777,0o700);
    assert.equal(connectorConfigDir(),path);
  } finally { fs.chmodSync=chmod; syncBuiltinESMExports(); fs.chmodSync(path,0o700); }
}
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
${scenario === "linked-config" ? `
const physical=fs.realpathSync(safe);
const selectionFile=join(dirname(selected),'selection.json');
const selection=readFileSync(selectionFile,'utf8');
process.env.XDG_CONFIG_HOME=physical;
assert.equal(connectorConfigDir(),selected,'the physical path preserves the saved selection');
fs.chmodSync(selected,0o500);
prepareConnectorConfigForUpdate();
assert.equal(fs.statSync(selected).mode&0o777,0o700);
assert.equal(readFileSync(selectionFile,'utf8'),selection,'alias use does not republish the record');
assertRootPermissionRefusal(selected);
const record=JSON.parse(selection), foreign=mkdtempSync(join(physical,'foreign-'));
writeFileSync(selectionFile,JSON.stringify({...record,root:join(foreign,selected.slice(join(safe,'cotal').length))}));
assert.throws(()=>connectorConfigDir(),/differs/,'the same retained suffix under a different config is refused');
writeFileSync(selectionFile,selection);
rmSync(selectionFile);
assert.equal(connectorConfigDir(),selected,'the physical path can use the same-version lineage');
writeFileSync(selectionFile,selection,{mode:0o600});
process.env.XDG_CONFIG_HOME=safe;
` : ""}
${scenario === "moved-config" ? `
const from=process.env.XDG_CONFIG_HOME, to=from+' café';
const selectedAt=path=>to+path.slice(from.length);
const selection=selectedAt(join(dirname(selected),'selection.json'));
const lineage=join(dirname(dirname(selection)),'current.json');
const moved=selectedAt(selected);
writeFileSync(join(selected,'extensions','extensions.json'),'{"extensions":[]}');
renameSync(from,to);
process.env.XDG_CONFIG_HOME=to;
const before=snapshot(to);
assert.equal(connectorConfigDir(),moved);
assert.equal(readFileSync(join(moved,'extensions/node_modules/old/lazy.js'),'utf8'),'old graph\\n');
assert.deepEqual(snapshot(to),before,'reading a moved selection does not write it back');
const {updateSnapshotConfig}=await import(${JSON.stringify(module)});
assert.equal(updateSnapshotConfig({snapshot:join(selected,'.update-snapshot-test'),previous:'0.165.4'}),undefined,'update recovery must not rebase a recorded snapshot');
renameSync(selection,selection+'.saved');
assert.equal(connectorConfigDir(),moved,'the moved lineage can name the current set');
assert.equal(canRecoverConnectorConfig(),true);
const originalMetadata=readFileSync(metadata);
try {
  writeFileSync(metadata,JSON.stringify({...JSON.parse(originalMetadata),version:'0.165.5'}));
  assert.equal(connectorConfigDir(),moved,'the moved lineage can name a previous set');
  assert.equal(canRecoverConnectorConfig(),false);
} finally { writeFileSync(metadata,originalMetadata); }
assert.equal(JSON.parse(readFileSync(lineage,'utf8')).root,selected);
renameSync(selection+'.saved',selection);
const explainsMove=reason=>error=>error.message.includes(JSON.stringify(selected)) &&
  error.message.includes(JSON.stringify(moved)) && error.message.includes(reason) &&
  error.message.includes('restore it there from a backup') && error.message.includes('Set XDG_CONFIG_HOME');
const extensions=join(moved,'extensions'), manifest=join(extensions,'extensions.json');
renameSync(extensions,extensions+'.saved');
assert.throws(()=>connectorConfigDir(),explainsMove('extensions directory is missing'));
renameSync(extensions+'.saved',extensions);
renameSync(manifest,manifest+'.saved');
assert.throws(()=>connectorConfigDir(),explainsMove('extensions manifest is missing'));
renameSync(manifest+'.saved',manifest);
assertRootPermissionRefusal(moved);
const versionDir=dirname(moved);
renameSync(versionDir,versionDir+'.saved');
symlinkSync(versionDir+'.saved',versionDir);
assert.throws(()=>connectorConfigDir(),explainsMove('is a symbolic link'));
assert.throws(()=>prepareConnectorConfigForUpdate(),explainsMove('is a symbolic link'));
renameSync(lineage,lineage+'.saved');
assert.throws(()=>connectorConfigDir(),error=>error.message.includes('not private') && !error.message.includes(selected),'never read selection.json through a linked version directory');
renameSync(lineage+'.saved',lineage);
rmSync(versionDir);
const lineageBefore=readFileSync(lineage);
assert.throws(()=>connectorConfigDir(),explainsMove('ENOENT'),'a missing version directory identifies both roots through lineage');
assert.throws(()=>prepareConnectorConfigForUpdate(),explainsMove('ENOENT'),'preflight does not recreate the missing version directory');
assert(!fs.existsSync(versionDir));
assert.deepEqual(readFileSync(lineage),lineageBefore);
renameSync(versionDir+'.saved',versionDir);
mkdirSync(join(from,'cotal'),{recursive:true,mode:0o700});
assert.throws(()=>connectorConfigDir(),explainsMove('differs'),'a separate existing config is not a move');
rmSync(join(from,'cotal'),{recursive:true});
symlinkSync(join(from,'missing'),join(from,'cotal'));
assert.throws(()=>connectorConfigDir(),/differs/,'a dangling old config link is not a move');
rmSync(from,{recursive:true});
symlinkSync(from+'-missing',from);
assert.throws(()=>connectorConfigDir(),explainsMove('ENOENT'),'a dangling old ancestor is not a move');
rmSync(from);
renameSync(moved,moved+'.saved');
assert.throws(()=>connectorConfigDir(),explainsMove('ENOENT'),'a missing destination identifies both roots');
assert.throws(()=>prepareConnectorConfigForUpdate(),explainsMove('ENOENT'),'preflight does not recreate the missing root');
renameSync(selection,selection+'.saved');
assert.throws(()=>connectorConfigDir(),explainsMove('ENOENT'),'a missing root named only by lineage identifies both roots');
renameSync(selection+'.saved',selection);
symlinkSync(moved+'.saved',moved);
assert.throws(()=>connectorConfigDir(),explainsMove('connector root is a symbolic link'));
assert.throws(()=>prepareConnectorConfigForUpdate(),explainsMove('connector root is a symbolic link'));
rmSync(moved);
renameSync(moved+'.saved',moved);
for (const name of ['seed','extensions']) {
  const path=join(moved,name);
  renameSync(path,path+'.saved');
  symlinkSync(path+'.saved',path);
  assert.throws(()=>connectorConfigDir(),explainsMove(name+' directory is a symbolic link'));
  assert.throws(()=>prepareConnectorConfigForUpdate(),explainsMove(name+' directory is a symbolic link'));
  rmSync(path);
  renameSync(path+'.saved',path);
}
renameSync(to,from);
process.env.XDG_CONFIG_HOME=from;
` : ""}
${scenario === "retain" ? `const unrelated=join(original,'installs','other-install');mkdirSync(unrelated,{mode:0o500});fs.chmodSync(selected,0o520);fs.chmodSync(join(selected,'seed'),0o500);prepareConnectorConfigForUpdate();assert.equal(connectorConfigDir(),selected);assert.equal(fs.statSync(selected).mode&0o777,0o700);assert.equal(fs.statSync(join(selected,'seed')).mode&0o777,0o700);assert.equal(fs.statSync(unrelated).mode&0o777,0o500);fs.chmodSync(unrelated,0o700);` : ""}
assert.equal(readFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'utf8'),'old graph\\n');
writeFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'new graph\\n');
assert.equal(readFileSync(join(original,'extensions/node_modules/old/lazy.js'),'utf8'),'old graph\\n');
assert.equal(readFileSync(join(original,'seed/stamp.json'),'utf8'),JSON.stringify({generation:'0.162.0'}));
${scenario === "interrupted-canonical-move" || scenario === "interrupted-canonical-cleanup" ? `
const set=dirname(selected), aside=join(set,'.retired-cotal');
const records=[join(set,'selection.json'),join(dirname(set),'current.json')];
const prior=records.map(path=>readFileSync(path));
const oldInode=fs.statSync(selected).ino;
renameSync(selected,aside);
${scenario === "interrupted-canonical-move" ? `
assert.equal(fs.existsSync(selected),false,'interrupted first rename leaves the canonical path absent');
prepareConnectorConfigForUpdate();
assert.equal(fs.statSync(selected).ino,oldInode,'self-update preflight restores the original directory');
assert.equal(readFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'utf8'),'new graph\\n');
` : `
fs.cpSync(aside,selected,{recursive:true});
fs.chmodSync(selected,0o700);
writeFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'replacement graph\\n');
const newInode=fs.statSync(selected).ino;
inheritConnectorConfig();
assert.equal(fs.statSync(selected).ino,newInode,'reconcile leaves the published replacement in place');
assert.equal(readFileSync(join(selected,'extensions/node_modules/old/lazy.js'),'utf8'),'replacement graph\\n');
`}
assert.equal(fs.existsSync(aside),false,'no retired directory remains after recovery');
assert.deepEqual(records.map(path=>readFileSync(path)),prior,'recovery does not republish the selection');
assert.equal(connectorConfigDir(),selected);
${scenario === "interrupted-canonical-move" ? `
renameSync(selected,aside);
assert.equal(canRecoverConnectorConfig(),true,'extension writer gate restores the directory before reading the selection');
assert.equal(fs.statSync(selected).ino,oldInode);
assert.equal(fs.existsSync(aside),false);
` : ""}
` : ""}
${scenario === "pnpm-dlx-refresh" ? `currentDlx=join(dlxB,'dist/cotal.js');assert.equal(connectorConfigDir(),selected,'refreshed pnpm dlx cache instance reuses the retained connector directory');assert.equal(retainConnectorConfig(),selected,'refreshed pnpm dlx cache instance does not create a second retained tree');assert.equal(fs.readdirSync(join(original,'installs')).length,1,'pnpm dlx cache refresh keeps one installs/<key> directory');` : ""}
${scenario === "unselected-holder" ? `const {retainConnectorSeat,pruneRetainedConnectorConfig}=await import(${JSON.stringify(module)});const before=snapshot(dirname(selected));writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.5',bin:{cotal:'./dist/cotal.js'}}));assert.equal(connectorConfigDir(),selected,'unselected version reads predecessor');const holder=retainConnectorSeat('manager-B','worker');assert.equal(holder.active,false,'unselected version must not reserve a holder');holder.launched(process.pid);holder.ended();pruneRetainedConnectorConfig([]);assert.deepEqual(snapshot(dirname(selected)),before,'unselected version neither writes predecessor nor prunes');assert.equal(fs.existsSync(join(dirname(dirname(selected)),'0.165.5')),false,'unselected version creates no set');` : ""}
${scenario === "shared-holder" ? `
const { retainConnectorSeat, pruneRetainedConnectorConfig } = await import(${JSON.stringify(module)});
const { installationWriter } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/update-closure.ts")).href)});
const { processStartToken } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/advisory-lock.ts")).href)});
const { once } = await import('node:events');
async function underForeignWriter(work) {
  const writer = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', ${JSON.stringify(`
    import { claimUpdateClosureAccess } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/update-closure.ts")).href)};
    const release = claimUpdateClosureAccess();
    process.once('disconnect', release);
    process.send('locked');
  `)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(writer, 'exit');
  try {
    assert.equal(await Promise.race([once(writer, 'message').then(([message]) => message), exited.then(() => 'exited')]), 'locked');
    assert.equal(installationWriter()?.pid, writer.pid);
    work();
    assert.equal(installationWriter()?.pid, writer.pid);
  } finally {
    if (writer.connected) writer.disconnect();
    assert.deepEqual(await exited, [0, null]);
  }
}
const dir = join(dirname(selected), 'holders');
const holder = retainConnectorSeat('manager-A', 'worker', true);
assert.equal(holder.active && holder.sharedEligible, true);
const [name] = fs.readdirSync(dir), file = join(dir, name);
const reservation = readFileSync(file, 'utf8');
assert.equal(JSON.parse(reservation).custody, undefined);
const child = {
  pid: process.pid,
  start: processStartToken(process.pid) ?? 'receipt-start',
  boot: process.platform === 'linux' ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : 'receipt-boot',
};
const stale = retainConnectorSeat('manager-A', 'worker', true);
const staleFile = join(dir, fs.readdirSync(dir).find(entry => entry !== name));
writeFileSync(staleFile + '.replacement', reservation, { mode: 0o600 });
fs.renameSync(staleFile + '.replacement', staleFile);
stale.bindSharedChild(child);
stale.ended();
assert.equal(readFileSync(staleFile, 'utf8'), reservation, 'a replaced reservation cannot be rebound or removed');
fs.chmodSync(dir, 0o755);
try { assert.equal(retainConnectorSeat('manager-A', 'worker', true).sharedEligible, false); }
finally { fs.chmodSync(dir, 0o700); }
rmSync(staleFile);
const unknown = retainConnectorSeat('manager-A', 'unacknowledged', true);
assert.equal(unknown.active && unknown.sharedEligible, true);
const unknownFile = join(dir, fs.readdirSync(dir).find(entry => entry !== name));
const oldMetadata = readFileSync(metadata);
writeFileSync(metadata, JSON.stringify({ ...JSON.parse(oldMetadata), version: '0.165.5' }));
retainConnectorConfig();
pruneRetainedConnectorConfig(['0.165.5']);
assert(fs.existsSync(unknownFile), 'pre-dispatch reservation pins old connectors before receipt');
await underForeignWriter(() => {
  holder.bindSharedChild(child);
  holder.launched(process.pid);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).custody, child, 'bind records the identity while the writer owns the lock');
  unknown.bindSharedChild(undefined);
  unknown.launched(process.pid);
  assert.equal(JSON.parse(readFileSync(unknownFile, 'utf8')).custody, undefined);
});
pruneRetainedConnectorConfig(['0.165.5']);
assert(fs.existsSync(unknownFile), 'unknown receipt keeps the identity-less reservation');
await underForeignWriter(() => {
  unknown.ended();
  assert.deepEqual(fs.readdirSync(dir), [name], 'proved exit under the writer removes the identity-less reservation');
});
pruneRetainedConnectorConfig(['0.165.5']);
assert(fs.existsSync(file), 'the exact live identity pins old connectors without the other reservation');
await underForeignWriter(() => {
  holder.ended();
  assert.deepEqual(fs.readdirSync(dir), [], 'proved exit under the writer removes the bound holder');
});
pruneRetainedConnectorConfig(['0.165.5']);
assert(!fs.existsSync(selected), 'the old set is collectible once the holders are released');
` : ""}
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
  // Published 0.171.2's previousConfig accepts exactly this selection shape.
  const accepts01712 = `(record, entry, sets) => record.v === 1 && record.entry === entry && /^\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(record.version) && record.root === join(sets, record.version, 'cotal')`;
  for (const source of ["canonical", "other-retained", "retained", "linked-retained", "identical", "seat-held"] as const) {
    const canonical = ["canonical", "other-retained", "identical"].includes(source);
    const expected = source === "identical" ? "pi installed" : "tmux added; pi removed";
    const config = join(root, `update-${source}`);
    mkdirSync(join(config, "cotal/seed"), { recursive: true, mode: 0o700 });
    mkdirSync(join(config, "cotal/extensions"), { mode: 0o700 });
    if (source === "linked-retained") {
      renameSync(config, `${config}-physical`);
      symlinkSync(`${config}-physical`, config);
    }
    const childScript = `
import assert from 'node:assert/strict';
import {chmodSync,existsSync,readFileSync,mkdirSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';
Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:${JSON.stringify(entry)},loadedEntry:${JSON.stringify(entry)}})});
const {connectorConfigDir,inheritConnectorConfig,prepareConnectorConfigForUpdate}=await import(${JSON.stringify(module)});
assert.equal(connectorConfigDir(),process.env.SNAPSHOT,'reconciliation reads the updater snapshot, not the stale target');
const staleExtensions=join(process.env.STALE,'extensions');
${source === "identical" ? "" : "chmodSync(staleExtensions,0o500);"}
prepareConnectorConfigForUpdate();
${source === "identical" ? "" : "assert.equal(statSync(staleExtensions).mode&0o777,0o500,'snapshot preflight leaves the stale target untouched');"}
const configHome=process.env.XDG_CONFIG_HOME;
const stage=join(dirname(process.env.STALE),'.extensions.stage-fixture','config');
mkdirSync(join(stage,'cotal/extensions'),{recursive:true,mode:0o700});
process.env.XDG_CONFIG_HOME=stage;
assert.equal(connectorConfigDir(),join(stage,'cotal'),'extension validation must keep its private stage');
process.env.XDG_CONFIG_HOME=configHome;
const oldInode=statSync(process.env.STALE).ino;
inheritConnectorConfig();
const selected=connectorConfigDir();
const accepts01712=${accepts01712};
const sets=dirname(dirname(process.env.STALE));
for (const record of [join(sets,'current.json'),join(dirname(process.env.STALE),'selection.json')]) {
  assert.equal(accepts01712(JSON.parse(readFileSync(record,'utf8')),${JSON.stringify(entry)},sets),${canonical});
}
${canonical ? "assert.equal(selected,process.env.STALE);" : "assert.notEqual(selected,process.env.STALE);assert.equal(readFileSync(join(process.env.STALE,'extensions/state'),'utf8'),'pi installed');"}
assert.equal(statSync(process.env.STALE).ino === oldInode, ${source !== "canonical" && source !== "other-retained"}, 'reuse keeps the inode but replacement installs the whole staged directory');
assert.equal(existsSync(join(dirname(process.env.STALE),'.retired-cotal')),false,'successful replacement removes the retired directory');
assert.equal(readFileSync(join(selected,'extensions/state'),'utf8'),${JSON.stringify(expected)});
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
import {chmodSync,cpSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
Object.defineProperty(globalThis,Symbol.for('cotal.execution.identity'),{value:Object.freeze({logicalEntry:${JSON.stringify(entry)},loadedEntry:${JSON.stringify(entry)}})});
const {retainConnectorConfig,connectorConfigDir,retainConnectorSeat,previousUpdateConnectorConfig}=await import(${JSON.stringify(module)});
const {claimUpdateClosureAccess,updateClosureChildEnv,updateClosureOwner}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/update-closure.ts")).href)});
const {writeUpdateRecovery,clearUpdateRecovery}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/updates.ts")).href)});
const metadata=${JSON.stringify(join(installed, "package.json"))};
writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.4',bin:{cotal:'./dist/cotal.js'}}));
const stale=retainConnectorConfig();
writeFileSync(join(stale,'extensions/state'),'pi installed');
${source === "seat-held" ? "retainConnectorSeat('manager','worker');" : ""}
${source === "other-retained" ? "writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.166.0',bin:{cotal:'./dist/cotal.js'}}));const other=retainConnectorConfig();writeFileSync(metadata,JSON.stringify({name:'cotal-ai',version:'0.165.4',bin:{cotal:'./dist/cotal.js'}}));" : ""}
const current=${["canonical", "identical", "seat-held"].includes(source) ? JSON.stringify(join(config, "cotal")) : source === "other-retained" ? "other" : "stale"};
${source === "identical" ? "rmSync(join(stale,'seed'),{recursive:true,force:true});mkdirSync(join(stale,'seed'),{mode:0o700});" : ""}
const snapshot=mkdtempSync(join(current,'.update-snapshot-'));
cpSync(join(${source === "identical" ? "stale" : "current"},'extensions'),join(snapshot,'extensions'),{recursive:true});
${source === "identical" ? "mkdirSync(join(snapshot,'seed'),{mode:0o700});for(const path of [stale,snapshot]){chmodSync(join(path,'extensions'),0o700);chmodSync(join(path,'extensions/state'),0o600);}" : ""}
writeFileSync(join(snapshot,'extensions/state'),${JSON.stringify(expected)});
const release=claimUpdateClosureAccess();
try {
writeUpdateRecovery({previous:'0.166.0',target:'0.165.4',installed:'0.166.0',phase:'replacing',reason:'test update',owner:updateClosureOwner(),snapshot});
const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',${JSON.stringify(childScript)}],{env:{...updateClosureChildEnv(process.env),COTAL_UPDATE_PARENT:String(process.pid),SNAPSHOT:snapshot,STALE:stale},encoding:'utf8'});
assert.equal(child.status,0,child.stdout+child.stderr);
assert.equal(previousUpdateConnectorConfig(),undefined,'active recovery hides rollback source from stage cleanup');
clearUpdateRecovery();
const selected=connectorConfigDir();
assert.equal(previousUpdateConnectorConfig(),current,'completed update exposes its validated rollback source');
assert.equal(selected === stale,${canonical},'completed update keeps its published selection');
assert.equal(readFileSync(join(selected,'extensions/state'),'utf8'),${JSON.stringify(expected)});
} finally { release(); }
`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...childEnv, XDG_CONFIG_HOME: config, COTAL_HOME: join(config, "home") }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `update-${source}: ${result.stdout}${result.stderr}`);
    passed++;
  }
  console.log("connector retention: original graph preserved, selected copy isolated, unsupported and forged state refused");
  emitSentinel({ passed, failed: 0 });
} finally { rmSync(root, { recursive: true, force: true }); }
