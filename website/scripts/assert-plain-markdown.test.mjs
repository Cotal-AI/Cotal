import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPlainMarkdown } from './assert-plain-markdown.mjs';

test('accepts reference prose, inline examples, and complete fenced code', () => {
  assertPlainMarkdown('These reads\nimport no provider.\n\nimport no provider and start nothing.\n\nimport data from a file.\n\nRead the [export reference](ref).\n\nUse `<Card>` in examples.\n\n```ts\nimport { Card } from "fumadocs-ui/components/card";\nexport const example = "<Cards>";\n```\n', 'valid reference');
});

test('rejects actual module declarations and component markup outside code', () => {
  for (const body of [
    'import { Card } from "fumadocs-ui/components/card";',
    'export const value = 1;',
    '<Cards>\n<Card title="Lost" href="x" />\n</Cards>',
  ]) assert.throws(() => assertPlainMarkdown(body, 'leak'), /no (executable|MDX)/);
});
