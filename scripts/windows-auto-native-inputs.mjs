// Assemble unchanged Linux seat helpers from a verified published archive, and fresh host artifacts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { list } from 'tar';
const root=resolve(import.meta.dirname,'..');
const metadata=await (await fetch('https://registry.npmjs.org/@cotal-ai%2fseat/0.164.7')).json();
assert.equal(metadata.name,'@cotal-ai/seat');assert.equal(metadata.version,'0.164.7');assert.match(metadata.gitHead,/^[a-f0-9]{40}$/);
execFileSync('git',['fetch','--no-tags','--depth=1','origin',metadata.gitHead],{cwd:root,stdio:'inherit'});
for(const file of ['native/peercred.c','scripts/build-native.mjs']){
 const published=execFileSync('git',['show',`${metadata.gitHead}:packages/seat/${file}`],{cwd:root});
 assert.deepEqual(published,readFileSync(join(root,'packages/seat',file)),`unchanged seat native input ${file}`);
}
const archive=Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
const [algorithm,value]=metadata.dist.integrity.split('-');assert.equal(algorithm,'sha512');assert.equal(createHash(algorithm).update(archive).digest('base64'),value);
const file=join(process.env.RUNNER_TEMP,'verified-seat.tgz');writeFileSync(file,archive);
const wanted=new Set(['package/build/Release/linux-x64/peercred.node','package/build/Release/linux-arm64/peercred.node']);
await list({file,strict:true,onReadEntry(entry){if(!wanted.has(entry.path)){entry.resume();return;}assert.equal(entry.type,'File');const chunks=[];entry.on('data',b=>chunks.push(b));entry.on('end',()=>{const rel=entry.path.slice('package/'.length),dest=join(root,'packages/seat',rel);mkdirSync(join(dest,'..'),{recursive:true});writeFileSync(dest,Buffer.concat(chunks));wanted.delete(entry.path);});}});
assert.equal(wanted.size,0);
for(const target of ['win32-x64','win32-arm64','darwin-x64','darwin-arm64']){
 const dest=join(root,'packages/seat/build/Release',target);mkdirSync(dest,{recursive:true});copyFileSync(join(root,'seat-inputs',`seat-native-${target}`,'peercred.node'),join(dest,'peercred.node'));
}
execFileSync(process.execPath,['packages/seat/scripts/assert-shipped-natives.mjs'],{cwd:root,stdio:'inherit'});
console.log(JSON.stringify({reusedLinuxSeatVersion:metadata.version,source:metadata.gitHead,integrity:metadata.dist.integrity,sourceInputsVerified:['native/peercred.c','scripts/build-native.mjs'],freshHostTargets:4}));
