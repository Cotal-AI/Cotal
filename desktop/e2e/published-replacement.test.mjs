import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./published-replacement.mjs', import.meta.url));
test('measurement refuses before any filesystem or native action outside a hosted run', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_')));
  delete env.GITHUB_ACTIONS; delete env.RUNNER_ENVIRONMENT;
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AssertionError/);
  assert.ok(!result.error && !result.signal);
});
test('measurement imports builtins only and contains no debug context, login or mutation fixture', () => {
  const source = readFileSync(script, 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
  assert.ok(imports.length > 0 && imports.every(name => name.startsWith('node:')));
  assert.ok(!/import\(/.test(source), 'do not add installed native-addon holders to the test harness');
  assert.ok(!/daemon\('(?:login|setup|service-connect)'/.test(source));
  assert.ok(!/COTAL_DESKTOP_E2E_CONTEXT|firstRun\(/.test(source));
  assert.ok(source.includes("assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')"));
});
