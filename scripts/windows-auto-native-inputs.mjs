// Assemble unchanged Linux seat helpers from a verified published archive, and fresh host artifacts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { list } from 'tar';
const root=resolve(import.meta.dirname,'..');
const metadata=await (await fetch('https://registry.npmjs.org/@cotal-ai%2fseat/0.164.7')).json();
assert.equal(metadata.name,'@cotal-ai/seat');assert.equal(metadata.version,'0.164.7');
// npm publication does not guarantee gitHead. Pin the actual public release tag instead.
const publishedSource='b9f7c9b61b27965829f3a8840de1ed74f01cc2af';
const tag=execFileSync('git',['ls-remote','--tags','origin','refs/tags/v0.164.7'],{cwd:root,encoding:'utf8'}).trim();
assert.equal(tag,`${publishedSource}\trefs/tags/v0.164.7`,'public seat release tag moved');
execFileSync('git',['fetch','--no-tags','--depth=1','origin',publishedSource],{cwd:root,stdio:'inherit'});
assert.equal(JSON.parse(execFileSync('git',['show',`${publishedSource}:packages/seat/package.json`],{cwd:root,encoding:'utf8'})).version,metadata.version);
for(const file of ['native/peercred.c','scripts/build-native.mjs']){
 const published=execFileSync('git',['show',`${publishedSource}:packages/seat/${file}`],{cwd:root});
 const committed=execFileSync('git',['show',`HEAD:packages/seat/${file}`],{cwd:root});
 assert.deepEqual(published,committed,`unchanged seat native input ${file}`);
 assert.equal(readFileSync(join(root,'packages/seat',file),'utf8').replaceAll('\r\n','\n'),committed.toString('utf8').replaceAll('\r\n','\n'),`checkout content matches native input ${file} after explicit CRLF normalization`);
}
const archive=Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
const [algorithm,value]=metadata.dist.integrity.split('-');assert.equal(algorithm,'sha512');assert.equal(createHash(algorithm).update(archive).digest('base64'),value);
const file=join(process.env.RUNNER_TEMP,'verified-seat.tgz');writeFileSync(file,archive);
const wanted=new Set(['package/build/Release/linux-x64/peercred.node','package/build/Release/linux-arm64/peercred.node']);
await list({file,strict:true,onReadEntry(entry){if(!wanted.has(entry.path)){entry.resume();return;}assert.equal(entry.type,'File');const chunks=[];entry.on('data',b=>chunks.push(b));entry.on('end',()=>{const rel=entry.path.slice('package/'.length),dest=join(root,'packages/seat',rel);mkdirSync(join(dest,'..'),{recursive:true});writeFileSync(dest,Buffer.concat(chunks));wanted.delete(entry.path);});}});
assert.equal(wanted.size,0);
for(const target of ['win32-x64','win32-arm64','darwin-x64','darwin-arm64']){
 const dest=join(root,'packages/seat/build/Release',target);mkdirSync(dest,{recursive:true});copyFileSync(join(process.env.SEAT_NATIVE_INPUTS,`seat-native-${target}`,'peercred.node'),join(dest,'peercred.node'));
}
execFileSync(process.execPath,['packages/seat/scripts/assert-shipped-natives.mjs'],{cwd:root,stdio:'inherit'});
console.log(JSON.stringify({reusedLinuxSeatVersion:metadata.version,source:publishedSource,integrity:metadata.dist.integrity,sourceInputsVerified:['native/peercred.c','scripts/build-native.mjs'],freshHostTargets:4}));
