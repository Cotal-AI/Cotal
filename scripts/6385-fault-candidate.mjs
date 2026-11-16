import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { create, extract, list } from 'tar';
import { isMainEntry } from './main-entry.mjs';

export const source6385 = '85e85968d09fa81972611d94954569f147bbbf97';
export const hash6385 = bytes => createHash('sha256').update(bytes).digest('hex');
export function injectDaemonFault(text, fault) {
  assert(['exit', 'hang'].includes(fault), 'fault must be exit or hang');
  const boundary = 'running = await serveDaemon(';
  assert.equal(text.split(boundary).length, 2, 'expected one built daemon serve boundary');
  const injection = fault === 'exit' ? 'process.exit(86);' : 'await new Promise(() => { setInterval(() => {}, 1000); });';
  return text.replace(boundary, `process.stderr.write("6385 test-package ${fault} reached before serveDaemon\\n");\n    ${injection}\n    ${boundary}`);
}

export async function archiveInventory(file) {
  const files = {};
  await list({ file, strict: true, onReadEntry(entry) {
    assert(entry.path.startsWith('package/') && !entry.path.split('/').includes('..'), 'unsafe archive path');
    if (entry.type === 'Directory') { entry.resume(); return; }
    assert.equal(entry.type, 'File', 'only regular candidate files supported');
    const name = entry.path.slice(8);
    assert(!Object.hasOwn(files, name), 'duplicate candidate file');
    const hash = createHash('sha256');
    entry.on('data', bytes => hash.update(bytes));
    entry.on('end', () => { files[name] = hash.digest('hex'); });
  } });
  return files;
}

/** Changes only a copied test package, never the checkout or source candidate. */
export async function buildFaultCandidate(candidate, output, fault) {
  candidate = resolve(candidate); output = resolve(output);
  assert(!existsSync(output), 'fault output must not exist');
  assert(!output.startsWith(candidate + '/'), 'output must be outside candidate');
  const original = readFileSync(join(candidate, 'manifest.json'));
  const manifest = JSON.parse(original);
  assert.equal(manifest.source, source6385);
  assert(Array.isArray(manifest.prepublishOnly) && manifest.prepublishOnly.length, 'guarded pack receipt required');
  for (const pkg of manifest.packages) {
    assert.match(pkg.archive, /^[^/\\]+\.tgz$/);
    const file = join(candidate, pkg.archive);
    assert.equal(hash6385(readFileSync(file)), pkg.sha256);
    assert.deepEqual(await archiveInventory(file), pkg.files);
  }
  assert(['exit', 'hang'].includes(fault));
  cpSync(candidate, output, { recursive: true, errorOnExist: true });
  const pkg = manifest.packages.find(row => row.name === 'cotal-ai');
  assert(pkg, 'binary package required');
  const staging = join(output, 'fault-package');
  mkdirSync(staging, { mode: 0o700 });
  await extract({ file: join(output, pkg.archive), cwd: staging, strict: true });
  const command = join(staging, 'package/dist/daemon/command.js');
  const before = readFileSync(command, 'utf8');
  writeFileSync(command, injectDaemonFault(before, fault));
  await create({ file: join(output, pkg.archive), cwd: staging, gzip: true, portable: true }, ['package']);
  pkg.files = await archiveInventory(join(output, pkg.archive));
  const bytes = readFileSync(join(output, pkg.archive));
  pkg.sha256 = hash6385(bytes);
  const receipt = { schema: 1, fault, source: source6385, inputManifestSha256: hash6385(original), package: pkg.name, file: 'dist/daemon/command.js', beforeSha256: hash6385(before), afterSha256: hash6385(readFileSync(command)), archiveSha256: pkg.sha256, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, label: 'synthetic test-package fault, not a product release' };
  manifest.testFault = receipt;
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(output, 'fault.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (isMainEntry(import.meta.url)) {
  const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]));
  await buildFaultCandidate(options.candidate, options.output, options.fault);
}
