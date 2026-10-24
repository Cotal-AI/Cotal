import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardMarkdown, dashboardOperations, dashboardPages, loadDashboardSpec } from './dashboard-api.mjs';

test('the downloadable contract has only resolvable local schema references', () => {
  const spec = loadDashboardSpec();
  const check = (value, path = '') => {
    if (value === null || typeof value !== 'object') return;
    if (value.$ref) {
      assert(value.$ref.startsWith('#/'), `External reference: ${value.$ref}`);
      assert.notEqual(value.$ref, '#' + path, 'A schema cannot be only a reference to itself');
      const target = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
      assert(target, `Unresolved reference: ${value.$ref}`);
    }
    for (const [key, child] of Object.entries(value)) check(child, path + '/' + key);
  };
  check(spec);
  assert.equal(JSON.stringify(spec), JSON.stringify(loadDashboardSpec()), 'Reference bundling is deterministic');
  assert(spec.components.schemas.WireCotalMessage.oneOf);
});

test('every operation retains parameters, errors and SSE payloads in Markdown', () => {
  const spec = loadDashboardSpec();
  const pages = dashboardPages(spec);
  const canonical = dashboardMarkdown(spec);
  assert.equal(pages.length, 8);
  for (const operation of dashboardOperations(spec)) {
    const markdown = pages.find((page) => page.slug.endsWith('/' + operation.operationId)).markdown;
    for (const text of [operation.path, operation.description, ...Object.keys(operation.responses), ...(operation.parameters ?? []).map((p) => p.description)]) {
      assert(markdown.includes(text), `Operation twin lost ${text}`);
    }
    assert(canonical.includes(operation.path));
    for (const name of Object.keys(operation['x-sse-events'] ?? {})) assert(markdown.includes(name));
  }
});

test('ambiguous plugin routes are refused before publication', () => {
  const spec = loadDashboardSpec();
  spec.paths['/api/roster'].get.operationId = spec.paths['/api/channels'].get.operationId;
  assert.throws(() => dashboardPages(spec), /Duplicate operation ID/);
});
