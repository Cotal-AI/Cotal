import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { writePluginFixture } from './plugin-fixture.mjs';

function privateDirectory(path) {
  const stat = lstatSync(path);
  assert.equal(realpathSync(path), path, 'diagnostic root must be canonical without symlink parents');
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'diagnostic root must be a real directory');
  if (process.getuid) assert.equal(stat.uid, process.getuid(), 'diagnostic directory owner differs');
}
export const redactDiagnostic = text => text.replace(/(#t=)[A-Za-z0-9_-]+/g, '$1<redacted>').replace(/eyJ[A-Za-z0-9_.-]*/g, '<redacted>');

export function writeUpgradeSeatConnector(fixture, { version, contract, core, recorder, seat }) {
  const launchedSeat = recorder?.launcher ?? seat;
  const launchRecord = recorder ? `writeFileSync(${JSON.stringify(recorder.paths.launch)},JSON.stringify({recordedAt:new Date().toISOString(),name:o.name,id:o.id,lifecycleUid:o.lifecycleUid,space:o.space,command:process.execPath,args:[${JSON.stringify(launchedSeat)}],seat:${JSON.stringify(seat)},cwd:process.cwd(),managerPid:process.pid},null,2),{mode:0o600});` : '';
  const provider = {kind: 'connector', name: 'upgrade-standin', requires: ['node']};
  const registration = contract === 1 ? 'export default host => host.register' : "import {registry} from '@cotal-ai/core'; registry.register";
  writePluginFixture(fixture, { name: 'cotal-upgrade-native-fixture', version, contract, core, provides: [provider],
    factorySource: `import {writeFileSync} from 'node:fs';${registration}({...${JSON.stringify(provider)},buildLaunch:o=>{${launchRecord}return {command:process.execPath,args:[${JSON.stringify(launchedSeat)}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),...(o.userAuth?{COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd)}:{COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id)}),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}}}});` });
}

export function writeHostedSeatRecorder(fixture, seat) {
  privateDirectory(fixture);
  const launcher = join(fixture, 'record-seat.mjs');
  const paths = Object.fromEntries(['stdout', 'stderr', 'exit', 'launch'].map(kind => [kind, join(fixture, `hosted-seat.${kind === 'stdout' || kind === 'stderr' ? `${kind}.log` : `${kind}.json`}`)]));
  writeFileSync(launcher, `import {spawn} from 'node:child_process';import {writeFileSync,appendFileSync} from 'node:fs';const paths=${JSON.stringify(paths)};const seat=${JSON.stringify(seat)};const startedAt=new Date().toISOString();for(const p of [paths.stdout,paths.stderr])writeFileSync(p,'',{mode:0o600});const child=spawn(process.execPath,[seat],{cwd:process.cwd(),env:process.env,stdio:['inherit','pipe','pipe']});const state={startedAt,pid:child.pid,command:process.execPath,args:[seat],cwd:process.cwd()};const save=extra=>writeFileSync(paths.exit,JSON.stringify({...state,...extra},null,2)+'\\n',{mode:0o600});save({state:'running'});child.stdout.on('data',b=>{appendFileSync(paths.stdout,b);process.stdout.write(b)});child.stderr.on('data',b=>{appendFileSync(paths.stderr,b);process.stderr.write(b)});child.on('error',e=>{save({state:'spawn-error',error:e.message,code:e.code,finishedAt:new Date().toISOString()});process.exitCode=1});child.on('close',(code,signal)=>{save({state:'exited',exit:code,signal,finishedAt:new Date().toISOString()});process.exitCode=code??1});for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>child.kill(s));`, { mode: 0o600 });
  return { launcher, paths };
}

// Only fixed fixture files and the selected space's stock Manager log are copied. Never env/auth trees.
export function archiveHostedDiagnostics({ fixture, cotalHome, space, output, id, stage = 'observed' }) {
  assert.match(space, /^[A-Za-z0-9_-]{1,64}$/);
  assert.match(stage, /^[a-z-]+$/);
  assert.match(id, /^[A-Za-z0-9_.-]+$/);
  privateDirectory(fixture); privateDirectory(cotalHome); privateDirectory(output);
  const manager = join(cotalHome, 'daemon', `space.${Buffer.from(space).toString('hex')}`, 'manager');
  const files = [
    ...['stdout.log', 'stderr.log', 'exit.json', 'launch.json'].map(name => ({ kind: `agent-${name}`, path: join(fixture, `hosted-seat.${name}`) })),
    ...['manager.log', 'manager.log.1'].map(name => ({ kind: name, path: join(manager, name) })),
  ];
  return files.map(({ kind, path }) => {
    if (!existsSync(path)) return { kind, path, state: 'missing' };
    try {
      for (let parent = path; parent !== fixture && parent !== cotalHome; parent = dirname(parent)) {
        assert(parent.startsWith(fixture + '/') || parent.startsWith(cotalHome + '/'), 'diagnostic escaped owned roots');
        assert(!lstatSync(parent).isSymbolicLink(), 'diagnostic parent must not be a symlink');
      }
      const stat = lstatSync(path);
      assert(stat.isFile() && !stat.isSymbolicLink(), 'diagnostic must be a regular no-follow file');
      if (process.getuid) assert.equal(stat.uid, process.getuid(), 'diagnostic owner differs');
      const raw = readFileSync(path), bytes = Buffer.from(redactDiagnostic(raw.toString('utf8'))), artifact = `${id}-hosted-${stage}-${kind}`;
      assert(!existsSync(join(output, artifact)), 'diagnostic destination must not already exist');
      writeFileSync(join(output, artifact), bytes, { mode: 0o600, flag: 'wx' });
      return { kind, path, state: 'archived', redacted: !raw.equals(bytes), artifact, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) { return { kind, path, state: 'unreadable', error: error.message }; }
  });
}
