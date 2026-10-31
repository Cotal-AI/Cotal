import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpReferences, referenceMarkdown, referenceOperations, referencePages, loadReferenceSpec } from './http-api.mjs';

for (const reference of httpReferences) {
  test(`${reference.id}: downloadable schemas resolve locally and deterministically`, () => {
    const spec = loadReferenceSpec(reference);
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
    assert.equal(JSON.stringify(spec), JSON.stringify(loadReferenceSpec(reference)));
    if (reference.id === 'dashboard') assert(spec.components.schemas.WireCotalMessage.oneOf);
  });

  test(`${reference.id}: Markdown retains request bodies, responses and event payloads`, () => {
    const spec = loadReferenceSpec(reference);
    const operations = referenceOperations(spec);
    const pages = referencePages(reference, spec);
    const canonical = referenceMarkdown(reference, spec);
    assert.equal(pages.length, operations.length + 1);
    for (const operation of operations) {
      const markdown = pages.find((page) => page.slug.endsWith('/' + operation.operationId)).markdown;
      for (const text of [operation.path, operation.description, ...Object.keys(operation.responses), ...(operation.parameters ?? []).map((p) => p.description)]) {
        assert(markdown.includes(text), `Operation twin lost ${text}`);
      }
      assert(canonical.includes(`${operation.method} ${operation.path}`));
      if (operation.requestBody) {
        assert(markdown.includes('### Request body'));
        for (const [type, content] of Object.entries(operation.requestBody.content)) {
          assert(markdown.includes(type));
          assert(markdown.includes(JSON.stringify(content.schema, null, 2)));
        }
      }
      for (const name of Object.keys(operation['x-sse-events'] ?? {})) assert(markdown.includes(name));
    }
  });

  test(`${reference.id}: ambiguous operation routes are refused`, () => {
    const spec = loadReferenceSpec(reference);
    const operations = Object.values(spec.paths).flatMap((item) => Object.values(item));
    operations[0].operationId = operations[1].operationId;
    assert.throws(() => referencePages(reference, spec), /Duplicate operation ID/);
  });
}
