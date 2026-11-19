import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
const hook = source.match(/  if \[ -n "\$PREVIOUS_VERSION" \] \|\| \[ -e[^\n]+\n[\s\S]*?\n  fi\n(?=  setup_path)/)[0];
assert.match(hook, /"\$BIN_DIR\/cotal" update/);
assert.doesNotMatch(hook, /update --self/);
for (const [previous, result, expected] of [['', 1, 0], ['0.164.0', 0, 0], ['0.160.7', 1, 1]]) {
  // The real-entry installer cells cover package installation. Isolate the shell gate here.
  const script = `
PREVIOUS_VERSION='${previous}'
BIN_DIR=/fixture
shquote() { printf "'%s'" "$1"; }
die() { printf '%s\\n' "$@"; exit 1; }
${hook.replace('"$BIN_DIR/cotal" update', `reconcile`)}
printf 'completed\\n'
`;
  const run = spawnSync('sh', ['-c', `reconcile() { printf 'reconcile output\\n'; return ${result}; }\n${script}`], { encoding: 'utf8' });
  assert.equal(run.status, expected);
  if (!previous) assert.doesNotMatch(run.stdout, /reconcile output/);
  else assert.match(run.stdout, /reconcile output/);
  if (expected) {
    assert.match(run.stdout, /Run '\/fixture\/cotal' update to finish this update\./);
    assert.doesNotMatch(run.stdout, /completed/);
  }
}
assert.match(source.trimEnd(), /\{ main "\$@"; exit \$\?; \}$/);
const readInstalledFn = source.match(/read_installed_version\(\) \{[\s\S]*?\n\}/)[0];
{
  const runRead = (versionLine, pkgVersion) => spawnSync('sh', ['-c', `
INSTALL_DIR=/tmp/nonexistent-cotal-install-test
COTAL_PKG=cotal-ai
NODE_BIN=node
${readInstalledFn.replace('[ -f "$_entry" ]', '[ -n "${TEST_ENTRY:-}" ]').replace('[ -f "$_pkg" ]', '[ -n "${TEST_PKG:-}" ]').replace('"$NODE_BIN" "$_entry" --version', 'printf "%s\\n" "$TEST_ENTRY"').replace('"$NODE_BIN" -e', 'printf "%s" "$TEST_PKG" #')}
read_installed_version
`], { encoding: 'utf8', env: { ...process.env, ...(versionLine ? { TEST_ENTRY: versionLine } : {}), ...(pkgVersion ? { TEST_PKG: pkgVersion } : {}) } });
  assert.equal(runRead('cotal-ai 0.164.1013', '0.164.13').stdout, '0.164.1013', 'prefers active CLI version in use over npm package.json');
  assert.equal(runRead('', '0.164.13').stdout, '0.164.13', 'falls back to npm package.json when entry --version is unavailable');
}
console.log('installer reconciliation: 3 paths passed');
