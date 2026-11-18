import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyOtherHomeAuthEvidence } from './other-home-auth-evidence.mjs';
const ok = r => { assert.equal(r.exit, 0, r.stdout + r.stderr); assert.equal(r.signal, null); assert.equal(r.timeout, false); return r; };
function graph(root) {
  const rows = [];
  const walk = (path, name) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) rows.push({ path: name, link: readlinkSync(path) });
    else if (stat.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child), `${name}/${child}`);
    else if (stat.isFile() && name !== '/dist/cotal.js') rows.push({ path: name, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
  };
  walk(root, ''); return rows;
}
export async function prepareOtherHomeAuth(context) {
  const { root, env, cli, pkg, report, call, options } = context;
  assert.equal(process.platform, 'linux');
  assert.equal(report.environment.hostedDisposable, true);
  assert.equal(options['other-home-auth'], 'true');
  assert.equal(options['next-hop-source'], 'candidate');
  assert.equal(options.state, 'daemon'); assert.equal(options.method, 'self'); assert.equal(options.layout, 'npm');
  const home = join(root, 'other-home'), project = join(home, 'project');
  for (const dir of [home, project, ...['.cotal', '.config', '.data', '.cache', '.state', 'runtime', 'tmp'].map(n => join(home, n))]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const other = { ...env, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.data'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.state'), XDG_RUNTIME_DIR: join(home, 'runtime'), TMPDIR: join(home, 'tmp') };
  delete other.COTAL_SPACE; delete other.COTAL_CREDS; delete other.COTAL_SERVER; delete other.COTAL_SERVERS;
  const scope = { env: other, cwd: project }, updater = { env, cwd: context.project };
  const run = (label, argv) => call(label, process.execPath, [cli, ...argv], undefined, scope);
  const e = report.otherHomeAuth = { mode: 'second-private-home-static-auth', home, updaterHome: env.HOME, project, space: 'other-home-proof', sourceVersion: report.source };
  let started = false;
  const cleanup = async () => {
    if (!started) return;
    if (report.calls.some(row => row.timeout || row.signal || row.exit === null)) throw Error('unknown command outcome: other-home stack retained for runner teardown');
    ok(await run('other home cleanup', ['down', '--space', e.space, '--with-agents', '--yes'])); started = false;
    assert(!existsSync(`/proc/${e.before.pid}`) || readFileSync(`/proc/${e.before.pid}/stat`, 'utf8').split(') ').at(-1).startsWith('Z '), 'Manager must retire');
  };
  const { localUpdateManagers } = await import(pathToFileURL(join(pkg, 'node_modules/@cotal-ai/cli/dist/commands/update.js')).href);
  const snapshot = () => {
    const rows = localUpdateManagers({ space: e.space }, cli); assert.equal(rows.length, 1);
    const m = rows[0], fields = readFileSync(`/proc/${m.pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ');
    assert.notEqual(fields[0], 'Z');
    const argv = readFileSync(`/proc/${m.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const entry = realpathSync(argv[1]), loadedRoot = dirname(dirname(entry));
    assert.equal(JSON.parse(readFileSync(join(loadedRoot, 'package.json'))).version, e.sourceVersion);
    return { pid: m.pid, birth: fields[19], instanceId: m.instanceId, root: m.root, argv, cwd: readlinkSync(`/proc/${m.pid}/cwd`), loadedRoot, loadedVersion: e.sourceVersion, graph: graph(loadedRoot) };
  };
  return Object.assign(cleanup, {
    async beforeUpdate() {
      assert(report.daemonBefore?.pid, 'machine service must be installed and ready');
      const { executionDescriptorPath } = await import(pathToFileURL(join(pkg, 'dist/cotal.js')).href);
      assert.equal(typeof executionDescriptorPath, 'function');
      assert(!existsSync(executionDescriptorPath(pkg)), 'B must launch clean first-generation candidate, not a retained selection');
      const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port; await new Promise(done => server.close(done));
      ok(await run('other home space create', ['space', 'create', e.space, '--root', project]));
      ok(await run('other home stack up', ['up', '--space', e.space, '--server', `nats://127.0.0.1:${port}`, '--root', project])); started = true;
      e.before = snapshot(); assert.equal(e.before.root, project);
      ok(await run('other home Manager before', ['ps', '--space', e.space, '--json']));
      const script = `const{readManagerContinuity}=await import(${JSON.stringify(pathToFileURL(join(pkg, 'node_modules/@cotal-ai/cli/dist/commands/update.js')).href)});try{await readManagerContinuity(${JSON.stringify({ space: e.space, server: `nats://127.0.0.1:${port}`, on: e.before.instanceId })});throw Error('original auth read unexpectedly succeeded')}catch(e){if(e.code!=='AUTH_REQUIRED'||e.native?.code!=='CREDENTIALS_MISSING')throw e;console.log(JSON.stringify({refused:true,code:e.code,nativeCode:e.native.code}))}`;
      e.authRead = ok(await call('other home original continuity read', process.execPath, ['--input-type=module', '-e', script], undefined, updater));
    },
    async afterUpdate() {
      ok(await run('other home Manager after', ['ps', '--space', e.space, '--json']));
      e.after = snapshot();
      const assertions = verifyOtherHomeAuthEvidence({ report, cell: { otherHomeAuth: true, platform: process.platform, sourceVersion: report.source } });
      for (const [name, passed] of Object.entries(assertions)) context.check(name, passed, { space: e.space, instance: e.before.instanceId });
    },
  });
}
