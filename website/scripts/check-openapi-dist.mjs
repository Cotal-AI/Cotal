import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const website = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(website, 'dist');
const sidebar = readFileSync(join(website, 'src/generated/sidebar.json'), 'utf8');
const apiOverview = readFileSync(join(dist, 'api-reference/index.html'), 'utf8');
let count = 0;
for (const [id, expected] of [['dashboard', 7], ['auth', 12]]) {
  const base = `api/${id}`;
  assert(existsSync(join(dist, base, 'index.html')), `${id} OpenAPI overview must be published`);
  const alias = readFileSync(join(dist, `${id}-api/index.html`), 'utf8');
  assert(alias.includes('http-equiv="refresh"') && alias.includes(`/${base}/`), `${id} source route must redirect to the plugin reference`);
  assert(!alias.includes('Reading the contract'), 'Aliases must not render another reference');
  assert(!existsSync(join(dist, `${id}-api.md`)), 'Only the canonical API URL publishes the complete Markdown reference');
  assert(!sidebar.includes(`${id}-api`), 'Generated sources must stay out of human navigation');
  assert(!apiOverview.includes(`href="/${id}-api/"`), 'The overview must link directly to the plugin');
  assert(apiOverview.includes(`href="/${base}/"`), `Missing canonical ${id} entry point`);
  const spec = JSON.parse(readFileSync(join(dist, `${id}.openapi.json`), 'utf8'));
  const complete = readFileSync(join(dist, `${base}.md`), 'utf8');
  const operations = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item)
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method))
    .map(([method, operation]) => ({ path, method, ...operation })));
  assert.equal(operations.length, expected, `${id} operation coverage changed`);
  for (const operation of operations) {
    const slug = `${base}/operations/${operation.operationId}`;
    const html = readFileSync(join(dist, slug, 'index.html'), 'utf8');
    assert(html.includes(operation.path.replaceAll('{', '&#123;').replaceAll('}', '&#125;')) || html.includes(operation.path), `HTML lost ${operation.path}`);
    assert(html.includes(`/${slug}.md`), `HTML must advertise its Markdown twin: ${slug}`);
    assert(complete.includes(operation.path) && complete.includes('## Schemas'), 'Canonical Markdown must include the full reference');
    const markdown = readFileSync(join(dist, `${slug}.md`), 'utf8');
    assert(markdown.includes(operation.path), `Markdown lost ${operation.path}`);
    if (operation.requestBody) assert(markdown.includes('### Request body'), `Markdown lost request: ${operation.operationId}`);
    for (const file of ['llms-full.txt', 'llms-small.txt']) assert(readFileSync(join(dist, file), 'utf8').includes(operation.path), `${file} lost ${operation.path}`);
  }
  assert(complete.includes(spec.info.title));
  assert(readFileSync(join(dist, 'llms.txt'), 'utf8').includes(`${id}.openapi.json`));
  assert(!JSON.stringify(spec).includes('../../spec/'), 'Downloads must resolve without repository files');
  count += operations.length;
}
console.log(`check-openapi-dist: ${count} HTTP operations have HTML, Markdown, agent indexes and bundled specifications`);
