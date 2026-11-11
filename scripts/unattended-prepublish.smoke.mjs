import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyParentIntegrity } from './unattended-parent-mirror.mjs';
const archiveBytes = Buffer.from('integrity fixture');
const integrity = 'sha512-' + createHash('sha512').update(archiveBytes).digest('base64');
verifyParentIntegrity(archiveBytes, integrity);
assert.throws(() => verifyParentIntegrity(Buffer.from('different'), integrity));
assert.throws(() => verifyParentIntegrity(archiveBytes, 'sha1-unsupported'));
assert.throws(() => verifyParentIntegrity(archiveBytes, undefined));
import { isolatedEnv, privateRegistry, validateConfig } from './unattended-prepublish.mjs';
const config = { optIn: 'unattended-prepublish-6385', registry: 'http://127.0.0.1:4873', candidate: '0.160.5', allowHosts: ['10.0.0.2'], key: '/private/id', knownHosts: '/private/known_hosts', machines: [{ host: '10.0.0.2', user: 'fixture', home: '/home/fixture', root: '/home/fixture/proof', prefix: '/home/fixture/.local/share/cotal', cli: '/home/fixture/.local/bin/cotal', node: '/home/fixture/.local/share/cotal/nodebin/node', hostname: 'cotal-test', existingMachine: 'authorized-disposable-6385', unit: 'cotal-daemon.service', parent: '0.160.3', mode: 'success' }] };
assert.equal(validateConfig(config), config);
for (const registry of ['https://registry.npmjs.org/', 'http://example.org/', 'http://user:secret@10.0.0.1/', 'http://10.0.0.1/path', 'http://172.32.0.1/']) assert.throws(() => privateRegistry(registry));
for (const patch of [{ optIn: false }, { candidate: '0.160.3' }, { candidate: '0.160.5-test.1' }, { allowHosts: ['other'] }, { allowHosts: ['unauthorized'] }]) assert.throws(() => validateConfig({ ...config, ...patch }));
for (const patch of [{ host: 'unauthorized' }, { host: '-oProxyCommand=bad' }, { root: '/tmp/unattended-6385/../foreign' }, { root: '/foreign/proof' }, { unit: 'bad;command.service' }, { mode: 'pretend' }]) assert.throws(() => validateConfig({ ...config, machines: [{ ...config.machines[0], ...patch }] }));
const env = isolatedEnv('/suite');
assert.equal(env.HOME, '/suite/home'); assert.equal(env.COTAL_HOME, '/suite/home/.cotal'); assert.equal(env.npm_config_userconfig, '/suite/npmrc');
assert(!('NPM_TOKEN' in env)); assert(!('SSH_AUTH_SOCK' in env));
import { chmodSync, chownSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publisherNpmrc } from './unattended-path-guards.mjs';
const fixture = mkdtempSync(join(realpathSync(tmpdir()), 'unattended-guards-'));
try {
  const repository = join(fixture, 'repository'); mkdirSync(repository);
  const file = join(fixture, 'publisher.npmrc'); writeFileSync(file, '', { mode: 0o600 });
  assert.equal(publisherNpmrc(file, repository), file);
  for (const mode of [0o644, 0o400, 0o660, 0o700, 0o4600]) {
    chmodSync(file, mode); assert.throws(() => publisherNpmrc(file, repository));
  }
  chmodSync(file, 0o600);
  const inside = join(repository, 'npmrc'); writeFileSync(inside, '', { mode: 0o600 });
  const link = join(fixture, 'link'); symlinkSync(file, link);
  const parentLink = join(fixture, 'alias'); symlinkSync(fixture, parentLink);
  for (const path of ['relative.npmrc', inside, link, join(parentLink, 'publisher.npmrc'), repository, `${fixture}/../publisher.npmrc`, `${file}\n`, join(fixture, 'missing')]) assert.throws(() => publisherNpmrc(path, repository));
  if (process.getuid() === 0) {
    chownSync(file, 1, 1); assert.throws(() => publisherNpmrc(file, repository));
    chownSync(file, 0, 0);
  }
} finally { rmSync(fixture, { recursive: true, force: true }); }
console.log('unattended prepublish guards passed (no network, registry, build, install or machine execution)');
