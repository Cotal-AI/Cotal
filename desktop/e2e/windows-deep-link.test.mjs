import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const probe = readFileSync(new URL('./windows-deep-link.ts', import.meta.url), 'utf8');
const native = readFileSync(new URL('../src-tauri/src/e2e_deep_link.rs', import.meta.url), 'utf8');
test('probe launches one fixed synthetic native URL without service actions', () => {
  assert.match(probe, /new URL\("cotal:\/\/connect"\)/);
  assert.match(probe, /link.searchParams.set\("idp", "http:\/\/127.0.0.1:9\/api\/auth"\)/);
  assert.match(probe, /link.searchParams.set\("space", "e2e-public-link"\)/);
  assert.match(probe, /driver.open\(binary, \[link.href\]\)/);
  assert.match(probe, /plugin:deep-link\|get_current/);
  assert.match(probe, /value:value===null\?null:Array.isArray\(value\)/);
  assert.match(probe, /redacted:true,bytes:/);
  assert.match(probe, /after-launch.png/);
  assert.doesNotMatch(probe, /\.click\(|\.fill\(|\.enter\(|@cotal-ai|taskkill|Stop-Process|process\.kill/);
});
test('private config has exclusive creation and exact ownership cleanup', () => {
  assert.match(probe, /mkdtempSync/);
  assert.match(probe, /flag: "wx"/);
  assert.match(probe, /if \(ownsConfig && cleanupSafe\)/);
  assert.match(probe, /if \(launchPending && !driver.session\) cleanupSafe = false/);
  assert.match(probe, /assert.equal\(readFileSync\(context, "utf8"\), config/);
  assert.match(probe, /await driver.close\(\)/);
  assert.match(probe, /server.kill\(\)/);
  assert.match(probe, /AbortSignal.timeout\(15_000\)/);
});
test('workflow blocks real journeys when diagnostic context remains', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  assert.match(workflow, /continue-on-error: true\s+timeout-minutes: 3\s+shell: pwsh\s+run: pnpm --dir desktop exec tsx e2e\/windows-deep-link.ts/);
  assert.match(workflow, /if \(Test-Path -LiteralPath 'desktop\/src-tauri\/target\/debug\/desktop-e2e.json'\) \{\s+throw 'Windows diagnostic context remains owned; real journeys will not overwrite it.'/);
});

test('additional native receipt retains only fixed public forms', () => {
  const helper = native.slice(native.indexOf('fn public_probe_argument'), native.indexOf('#[cfg(test)]'));
  assert.match(helper, /const EXPECTED: &str = "cotal:\/\/connect\?idp=http%3A%2F%2F127.0.0.1%3A9%2Fapi%2Fauth&space=e2e-public-link"/);
  assert.match(helper, /value == EXPECTED/);
  assert.match(helper, /strip_prefix\("--"\) == Some\(EXPECTED\)/);
  assert.match(helper, /_ => None/);
  assert.doesNotMatch(helper, /value\.to_owned|value\.to_string|json!\([^\n]*: value[,}]/);
  assert.match(native, /"publicProbeShapes": probe_shapes/);
});
