/** Real endpoint connector and public spawn path shared by desktop upgrade acceptance suites. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function installFixtureSeat({ root, runtime, node, env, cwd, space, managerInstanceId }) {
  const cli = join(runtime, 'dist', 'cotal.js');
  const connector = join(root, 'fixture-seat-connector');
  const ready = join(root, 'fixture-seat-ready.json');
  const release = join(root, 'fixture-seat-release');
  mkdirSync(connector, { recursive: true });
  const core = pathToFileURL(join(runtime, 'node_modules', '@cotal-ai', 'core', 'dist', 'index.js')).href;
  writeFileSync(join(connector, 'package.json'), JSON.stringify({ name: 'cotal-fixture-seat', version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '>=0.1.0' } }));
  writeFileSync(join(connector, 'seat.mjs'), `import {CotalEndpoint} from ${JSON.stringify(core)};import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {execFile} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
const command=JSON.parse(process.env.COTAL_BEARER_CMD);const bearer=()=>new Promise((resolve,reject)=>execFile(command[0],command.slice(1),{windowsHide:true},(error,out)=>error?reject(error):resolve(out.trim())));
const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,bearer,sentinelCreds:readFileSync(process.env.COTAL_SENTINEL_CREDS,'utf8'),lifecycleUid:process.env.COTAL_LIFECYCLE_UID,channels:[],consume:false,card:{owner:process.env.COTAL_OWNER,actor:process.env.COTAL_ACTOR,name:process.env.COTAL_NAME,kind:'agent'}});ep.on('error',()=>{});await ep.start();writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,name:process.env.COTAL_NAME,version:JSON.parse(readFileSync(${JSON.stringify(join(runtime, 'package.json'))},'utf8')).version,startedAt:new Date().toISOString()}));while(!existsSync(${JSON.stringify(release)}))await delay(100);await ep.close();`);
  writeFileSync(join(connector, 'index.js'), `import {registry} from '@cotal-ai/core';import {fileURLToPath} from 'node:url';registry.register({kind:'connector',name:'fixture-seat',requires:['node'],buildLaunch:o=>({command:${JSON.stringify(node)},args:[fileURLToPath(new URL('./seat.mjs',import.meta.url))],env:{PATH:process.env.PATH,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,COTAL_HOME:process.env.COTAL_HOME,COTAL_SKIP_CONNECTOR_SEED:'1',COTAL_SPACE:o.space,COTAL_SERVERS:o.servers,COTAL_NAME:o.name,COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd),COTAL_LIFECYCLE_UID:o.lifecycleUid}})});`);
  const call = args => new Promise((resolve, reject) => execFile(node, [cli, ...args], { env, cwd, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${args.join(' ')}: ${stderr || stdout || error.message}`)) : resolve(stdout)));
  await call(['ext', 'add', connector]);
  return {
    async spawn(instance = managerInstanceId) {
      assert.ok(instance, 'A real daemon-hosted Manager instance is required');
      const result = JSON.parse(await call(['spawn', '--on', instance, '--space', space, '--harness', 'fixture-seat', '--name', 'upgrade_fixture', '--no-events', '--detach', '--json']));
      assert.equal(result.result?.readiness, 'joined', JSON.stringify(result));
      const deadline = Date.now() + 30_000;
      while (!existsSync(ready) && Date.now() < deadline) await delay(100);
      assert.ok(existsSync(ready), 'The endpoint agent must actually join inside its PTY');
      return { ...JSON.parse(readFileSync(ready, 'utf8')), spawnResult: result };
    },
    release() { writeFileSync(release, 'release\n'); },
    ready,
    async stop(instance = managerInstanceId) { await call(['stop', 'upgrade_fixture', '--on', instance, '--space', space, '--json']); },
  };
}
