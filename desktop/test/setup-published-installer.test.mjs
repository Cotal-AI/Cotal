import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selectPublishedInstaller } from './setup-published-installer.mjs';

const asset = version => ({
  name: `Cotal_${version}_x64-setup.exe`, digest: `sha256:${'a'.repeat(64)}`,
  browser_download_url: `https://github.com/Cotal-AI/Cotal/releases/download/v${version}/Cotal_${version}_x64-setup.exe`,
});
const release = (version, assets = [asset(version)]) => ({ tag_name: `v${version}`, assets });

test('selects the newest available installer, including the third release', () => {
  assert.equal(selectPublishedInstaller([release('0.165.2'), release('0.165.1')]).version, '0.165.2');
  assert.equal(selectPublishedInstaller([release('0.165.2', []), release('0.165.1')]).version, '0.165.1');
  assert.equal(selectPublishedInstaller([release('0.165.2', []), release('0.165.1', []), release('0.165.0')]).version, '0.165.0');
});

test('does not search beyond three releases or accept an unrelated platform asset', () => {
  assert.throws(() => selectPublishedInstaller([
    release('0.165.3', []), release('0.165.2', []), release('0.165.1', [{ name: 'Cotal_arm64-setup.exe' }]), release('0.165.0'),
  ]), /newest three/);
  assert.throws(() => selectPublishedInstaller([]), /newest three/);
});

test('duplicate, missing and malformed digests refuse rather than select an older installer', () => {
  for (const assets of [[asset('0.165.2'), asset('0.165.2')], [{ ...asset('0.165.2'), digest: undefined }], [{ ...asset('0.165.2'), digest: 'sha256:bad' }]]) {
    assert.throws(() => selectPublishedInstaller([release('0.165.2', assets), release('0.165.1')]), /Duplicate|digest unavailable/);
  }
});

test('does not select a draft, prerelease or non-version tag', () => {
  for (const first of [{ ...release('0.165.2'), draft: true }, { ...release('0.165.2'), prerelease: true }, { ...release('0.165.2'), tag_name: 'nightly' }]) {
    assert.equal(selectPublishedInstaller([first, release('0.165.1')]).version, '0.165.1');
  }
});

test('malformed metadata refuses and selected asset identity is preserved', () => {
  assert.throws(() => selectPublishedInstaller({}), /must be an array/);
  assert.throws(() => selectPublishedInstaller([{ tag_name: 'v0.165.2' }]), /assets unavailable/);
  const selected = selectPublishedInstaller([release('0.165.2')]);
  assert.deepEqual(selected, { version: '0.165.2', ...asset('0.165.2') });
});

test('workflow exercises selection, pins its version and still verifies downloaded bytes', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/windows-setup-proof.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(workflow, /node --test desktop\/test\/setup-published-installer.test.mjs/);
  assert.match(workflow, /\$selectedJson = node desktop\/test\/setup-published-installer.mjs/);
  assert.match(workflow, /if\(\$LASTEXITCODE -ne 0\)\{throw 'Could not select/);
  assert.match(workflow, /COTAL_SETUP_LATEST_VERSION=\$\(\$selected.version\)/);
  assert.match(workflow, /Registry latest .* has no installer yet/);
  assert.match(workflow, /\$asset=@\(\$selected\)/);
  assert.match(workflow, /Get-FileHash \$path -Algorithm SHA256/);
  assert.match(workflow, /Published installer digest mismatch/);
});
