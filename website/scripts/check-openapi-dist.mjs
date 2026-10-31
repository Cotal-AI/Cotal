import assert from 'node:assert/strict';
import { parse } from 'parse5';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const website = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(website, 'dist');
const sidebar = readFileSync(join(website, 'src/generated/navigation.mjs'), 'utf8');
const redirects = readFileSync(join(dist, '_redirects'), 'utf8');
const apiOverview = readFileSync(join(dist, 'api-reference/api-reference/index.html'), 'utf8');
const textOf = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(textOf).join('');
const find = (node, predicate) => predicate(node) ? node : (node.childNodes ?? []).map(child => find(child, predicate)).find(Boolean);
let count = 0;
for (const [id, expected] of [['dashboard', 7], ['auth', 12]]) {
  const base = `api/${id}`;
  assert(existsSync(join(dist, base, 'index.html')), `${id} OpenAPI overview must be published`);
  for (const alias of [`/${id}-api`, `/${id}-api/`]) {
    assert(redirects.includes(`${alias} /${base}/ 301`), `${id} source route must redirect to the canonical reference`);
  }
  assert(!existsSync(join(dist, `${id}-api/index.html`)), 'Aliases must not render another reference');
  assert(!existsSync(join(dist, `${id}-api.md`)), 'Only the canonical API URL publishes the complete Markdown reference');
  assert(!sidebar.includes(`${id}-api`), 'Generated sources must stay out of human navigation');
  assert(!apiOverview.includes(`href="/${id}-api/"`), 'The overview must link directly to the HTTP reference');
  assert(apiOverview.includes(`href="/${base}/"`), `Missing canonical ${id} entry point`);
  const spec = JSON.parse(readFileSync(join(dist, `${id}.openapi.json`), 'utf8'));
  const complete = readFileSync(join(dist, `${base}.md`), 'utf8');
  const overview = parse(readFileSync(join(dist, base, 'index.html'), 'utf8'));
  for (const [name, schema] of Object.entries(spec.components.schemas).filter(([name]) => !name.startsWith('Wire'))) {
    assert(find(overview, node => node.tagName === 'h3' && find(node, child => child.tagName === 'a' && textOf(child).trim() === name)), `HTML schema definition: ${id}/${name}`);
    const code = find(overview, node => node.tagName === 'pre' && textOf(node).trim() === JSON.stringify(schema, null, 2));
    assert(code, `Complete HTML schema body: ${id}/${name}`);
  }
  const operations = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item)
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method))
    .map(([method, operation]) => ({ path, method, ...operation })));
  assert.equal(operations.length, expected, `${id} operation coverage changed`);
  for (const operation of operations) {
    const slug = `${base}/operations/${operation.operationId}`;
    const html = readFileSync(join(dist, slug, 'index.html'), 'utf8');
    assert(html.includes(`id="${operation.operationId}"`), `Stable operation anchor: ${operation.operationId}`);
    const endpoint = `${operation.method.toUpperCase()} ${operation.path}`;
    const figure = find(parse(html), node => node.tagName === 'figure' && find(node, child => child.tagName === 'pre' && textOf(child).trim() === endpoint));
    assert(figure && find(figure, node => node.tagName === 'button' && textOf(node) === 'Copy Text'), `Copyable HTTP endpoint: ${endpoint}`);
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
