import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';

/** Two homes share one installed CLI, but each must reconcile its own built-ins before launch. */
export async function twoHomeUpgrade({ oldDirectory, targetDirectory, root }) {
  assert(['linux', 'darwin'].includes(process.platform), 'two-home installed-prefix proof is POSIX only');
  root = resolve(root);
  assert(!existsSync(root), 'two-home proof needs a new private root');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const report = { source: 'real installed candidate pair', calls: [], checks: [], cleanup: 'not-started' };
  const save = () => writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  const check = (name, value) => { report.checks.push({ name, passed: Boolean(value) }); save(); assert(value, name); };
  const old = await candidateRegistry(resolve(oldDirectory), 'A', 'https://registry.npmjs.org/');
  let target;
  try {
    target = await candidateRegistry(resolve(targetDirectory), 'B', 'https://registry.npmjs.org/');
    report.old = old.identity; report.target = target.identity;
    for (const route of ['up', 'launch']) {
      const directory = join(root, route);
      const prefix = join(root, 'prefix');
      const entry = join(prefix, 'bin', 'cotal');
      const environments = {};
      for (const home of ['A', 'B']) {
        const homeRoot = join(directory, home);
        for (const part of ['', 'config', 'cotal', 'runtime', 'tmp', 'project']) mkdirSync(join(homeRoot, part), { recursive: true, mode: 0o700 });
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH', 'npm_config_before', 'NPM_CONFIG_BEFORE'].includes(key)));
        Object.assign(env, { HOME: homeRoot, COTAL_HOME: join(homeRoot, 'cotal'), XDG_CONFIG_HOME: join(homeRoot, 'config'), XDG_RUNTIME_DIR: join(homeRoot, 'runtime'), TMPDIR: join(homeRoot, 'tmp'), npm_config_prefix: prefix, npm_config_cache: join(directory, 'cache'), npm_config_registry: old.url, DO_NOT_TRACK: '1', NO_COLOR: '1', PATH: [join(prefix, 'bin'), env.PATH].join(delimiter) });
        environments[home] = env;
      }
      const call = async (home, label, file, args) => {
        const child = spawn(file, args, { cwd: join(directory, home, 'project'), env: environments[home], stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
        const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
        try {
          const { code, signal } = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
          const row = { route, home, label, args, code, signal, stdout, stderr };
          report.calls.push(row); save(); return row;
        } finally { clearTimeout(timer); }
      };
      const ok = async (home, label, args) => { const row = await call(home, label, entry, args); check(`${route} ${home} ${label} exits zero`, row.code === 0 && row.signal === null); return row; };
      let running = false;
      try {
        const install = await call('A', 'install old closure', 'npm', ['install', '-g', `cotal-ai@${old.identity.version}`]);
        check(`${route} installs normal old closure`, install.code === 0 && install.signal === null);
        for (const home of ['A', 'B']) {
          await ok(home, 'seed old home', ['ext', 'seed']);
          const version = await ok(home, 'old version', ['--version']);
          check(`${route} ${home} built-ins start at A`, inventory(version.stdout, old.identity.version));
        }
        const fixture = join(directory, 'fixture'); mkdirSync(fixture, { mode: 0o700 });
        const core = pathToFileURL(join(prefix, 'lib/node_modules/cotal-ai/node_modules/@cotal-ai/core/dist/index.js')).href;
        writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'cotal-two-home-seat', version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } }));
        const joined = join(fixture, 'joined.json');
        writeFileSync(join(fixture, 'seat.mjs'), `import{CotalEndpoint}from${JSON.stringify(core)};import{readFileSync,writeFileSync}from'node:fs';const e=process.env;const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,creds:readFileSync(e.COTAL_CREDS,'utf8'),card:{id:e.COTAL_ID,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});await ep.start();writeFileSync(${JSON.stringify(joined)},JSON.stringify({pid:process.pid,name:e.COTAL_NAME,lifecycleUid:e.COTAL_LIFECYCLE_UID}));setTimeout(()=>ep.stop().finally(()=>process.exit(0)),2000);`);
        writeFileSync(join(fixture, 'index.js'), `import{registry}from'@cotal-ai/core';registry.register({kind:'connector',name:'two-home-seat',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[${JSON.stringify(join(fixture, 'seat.mjs'))}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
        if (route === 'launch') await ok('B', 'register fixture', ['ext', 'add', fixture]);
        await ok('B', 'prepare space', ['space', 'create', 'twohomes', '--plain']);
        running = true;
        await ok('B', 'start original space', ['up', '--detach', ...(route === 'launch' ? ['--no-manager'] : [])]);
        if (route === 'up') { await ok('B', 'stop original space', ['down', '--yes']); running = false; }
        environments.A.npm_config_registry = target.url;
        await ok('A', 'self update shared installation', ['update', '--self']);
        const a = await ok('A', 'updated home version', ['--version']);
        check(`${route} A is fully reconciled`, inventory(a.stdout, target.identity.version) && !a.stdout.includes('Reconciliation pending'));
        const stale = await ok('B', 'stale home version before command', ['--version']);
        check(`${route} B starts stale in shared installation`, stale.stdout.startsWith(`cotal-ai ${target.identity.version}\n`) && inventory(stale.stdout, old.identity.version));
        check(`${route} home-only hint never asks for self replacement`, !stale.stdout.includes('update --self'));
        if (route === 'up') { await ok('B', 'ordinary next up', ['up', '--detach']); running = true; }
        else {
          await ok('B', 'ordinary next agent launch', ['spawn', '--foreground', '--agent', 'two-home-seat', '--name', 'twohome-proof', '--no-events']);
          const seat = JSON.parse(readFileSync(joined, 'utf8'));
          check('a real fixture seat joined without signed-in harness', seat.pid > 0 && seat.name === 'twohome-proof' && typeof seat.lifecycleUid === 'string');
          report.seat = seat;
        }
        const b = await ok('B', 'home version after ordinary command', ['--version']);
        check(`${route} ordinary command reconciles B completely`, inventory(b.stdout, target.identity.version) && !b.stdout.includes('Reconciliation pending'));
        const manifest = join(directory, 'B/config/cotal/extensions/extensions.json');
        report[`${route}ManifestSha256`] = createHash('sha256').update(readFileSync(manifest)).digest('hex');
      } finally {
        if (running) {
          const cleanup = await call('B', 'final owned stack down', entry, ['down', '--yes']);
          check(`${route} owned stack cleanup confirmed`, cleanup.code === 0 && cleanup.signal === null);
        }
      }
    }
    report.cleanup = 'both owned stacks stopped'; report.acceptance = true; save(); return report;
  } finally { if (target) await target.close(); await old.close(); save(); }
}

function inventory(output, version) {
  return ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web, web-service'].every(name => output.split('\n').some(line => line.trimStart().startsWith(name) && line.trimEnd().endsWith(version)));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [oldDirectory, targetDirectory, root] = process.argv.slice(2);
  assert(oldDirectory && targetDirectory && root, 'usage: automatic-update-two-homes.mjs <old-packed-closure> <target-packed-closure> <new-private-root>');
  await twoHomeUpgrade({ oldDirectory, targetDirectory, root });
}
