import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
const hook = source.match(/  write_launcher\n([\s\S]*?)  setup_path/)[1];
assert.match(hook, /"\$BIN_DIR\/cotal" update --self/);
for (const [previous, result, expected] of [['', 1, 0], ['0.164.0', 0, 0], ['0.160.7', 1, 1]]) {
  // The real-entry installer cells cover package installation. Isolate the shell gate here.
  const script = `
PREVIOUS_VERSION='${previous}'
BIN_DIR=/fixture
shquote() { printf "'%s'" "$1"; }
die() { printf '%s\\n' "$@"; exit 1; }
${hook.replace('"$BIN_DIR/cotal" update --self', `reconcile`)}
printf 'completed\\n'
`;
  const run = spawnSync('sh', ['-c', `reconcile() { printf 'reconcile output\\n'; return ${result}; }\n${script}`], { encoding: 'utf8' });
  assert.equal(run.status, expected);
  if (!previous) assert.doesNotMatch(run.stdout, /reconcile output/);
  else assert.match(run.stdout, /reconcile output/);
  if (expected) {
    assert.match(run.stdout, /Run '\/fixture\/cotal' update --self to finish this update\./);
    assert.doesNotMatch(run.stdout, /completed/);
  }
}
assert.match(source.trimEnd(), /\{ main "\$@"; exit \$\?; \}$/);
console.log('installer reconciliation: 3 paths passed');
