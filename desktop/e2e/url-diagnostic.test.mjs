import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { collectUrlDiagnostic } from './url-diagnostic.mjs';

const evaluate = async (script, args) => vm.runInNewContext(`(function(){${script}}).apply(null, args)`, {
  URL, args, navigator: { userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.1.2 Safari/537.36 Edg/130.0.3.4 secret-ua-marker' },
});
test('script records URL components and version numbers without secret URL fields or arbitrary UA', async () => {
  const result = JSON.parse(JSON.stringify(await collectUrlDiagnostic(evaluate,
    'cotal://private-user:private-password@connect?idp=private-query#private-fragment')));
  assert.deepEqual(result, { source: 'app-webview', components: {
    protocol: 'cotal:', hostname: 'connect', pathname: '', port: '', hash: '[present]',
  }, browser: { chromium: '130.0.1.2', edge: '130.0.3.4', webkit: '537.36', safari: null } });
  assert.doesNotMatch(JSON.stringify(result), /private-|secret-ua-marker/);
});
test('blank hash is distinguishable from present hash and constructor errors are sanitized', async () => {
  const blank = await collectUrlDiagnostic(evaluate, 'cotal://connect?idp=private-query');
  assert.equal(blank.components.hash, '');
  const invalid = await collectUrlDiagnostic(evaluate, 'private-invalid');
  assert.equal(invalid.components.error, 'URL_CONSTRUCTION_FAILED');
  assert.doesNotMatch(JSON.stringify(invalid), /private-invalid/);
  const failed = await collectUrlDiagnostic(async () => { throw new Error('private-query'); }, 'private-link');
  assert.deepEqual(failed, { source: 'app-webview', error: 'WEBVIEW_EVALUATION_FAILED' });
});
test('unexpected WebView reply cannot smuggle secrets into the artifact', async () => {
  const valid = await evaluate((await import('./url-diagnostic.mjs')).urlDiagnosticScript, ['cotal://connect']);
  for (const reply of [{ ...valid, query: 'private-query' }, { ...valid, components: { ...valid.components, hash: '#private-fragment' } }, { ...valid, browser: { ...valid.browser, chromium: 'private-userinfo' } }]) {
    const result = await collectUrlDiagnostic(async () => reply, 'cotal://connect');
    assert.deepEqual(result, { source: 'app-webview', error: 'WEBVIEW_EVALUATION_FAILED' });
  }
});
test('Windows and Linux journeys evaluate identical fixed input before the real link wait', () => {
  const journey = readFileSync(new URL('./first-run.ts', import.meta.url), 'utf8');
  assert.match(journey, /if \(driver instanceof WindowDriver\) \{\s+const diagnostic = await collectUrlDiagnostic/);
  assert.match(journey, /\{ script, args \}\), publicDiagnosticLink\)/);
  assert.ok(journey.indexOf('const diagnostic = await collectUrlDiagnostic') < journey.indexOf('await until("deep link visible"'));
});

test('Windows attached probe uses script before the scenario-length context wait', () => {
  const source = readFileSync(new URL('./windows-deep-link.ts', import.meta.url), 'utf8');
  assert.match(source, /collectUrlDiagnostic\([\s\S]*?driver.call\("POST", driver.path\("execute\/sync"\), \{ script, args \}\), link.href\)/);
  assert.ok(source.indexOf('observations.urlDiagnostic =') < source.indexOf('await until("plain public link context visible"'));
  assert.match(source, /await until\("plain public link context visible", \(\) => driver.displayed\("link-context"\), Boolean\);/);
});
