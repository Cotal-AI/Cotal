import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const website = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(website, 'dist');
assert(existsSync(join(dist, 'api/dashboard/index.html')), 'Dashboard OpenAPI overview must be published');
const legacy = readFileSync(join(dist, 'dashboard-api/index.html'), 'utf8');
assert(legacy.includes('http-equiv="refresh"') && legacy.includes('/api/dashboard/'), 'Legacy dashboard URL must redirect instead of rendering a second reference');
assert(!legacy.includes('Reading the contract'), 'Legacy dashboard URL must not contain the reference');
assert(!existsSync(join(dist, 'dashboard-api.md')), 'Only the canonical API URL publishes the complete Markdown reference');
const sidebar = readFileSync(join(website, 'src/generated/sidebar.json'), 'utf8');
assert(!sidebar.includes('dashboard-api'), 'The generated reference must stay out of human navigation');
const apiOverview = readFileSync(join(dist, 'api-reference/index.html'), 'utf8');
assert(!apiOverview.includes('href="/dashboard-api/"'), 'Overview must link directly to the plugin reference');
const spec = JSON.parse(readFileSync(join(dist, 'dashboard.openapi.json'), 'utf8'));
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
    .map(([method, operation]) => ({ path, method, ...operation })));
assert.equal(operations.length, 7, 'Publish the seven dashboard read operations');
for (const operation of operations) {
  const slug = `api/dashboard/operations/${operation.operationId}`;
  const html = readFileSync(join(dist, slug, 'index.html'), 'utf8');
  assert(html.includes(operation.path.replaceAll('{', '&#123;').replaceAll('}', '&#125;')) || html.includes(operation.path), `HTML lost ${operation.path}`);
  assert(html.includes(`/${slug}.md`), `HTML must advertise its Markdown twin: ${slug}`);
  const complete = readFileSync(join(dist, 'api/dashboard.md'), 'utf8');
  assert(complete.includes(operation.path) && complete.includes('Response schemas'), 'Canonical Markdown must include the complete reference');
  const markdown = readFileSync(join(dist, `${slug}.md`), 'utf8');
  assert(markdown.includes(operation.path), `Markdown lost ${operation.path}`);
  for (const file of ['llms-full.txt', 'llms-small.txt']) {
    assert(readFileSync(join(dist, file), 'utf8').includes(operation.path), `${file} lost ${operation.path}`);
  }
}
assert(readFileSync(join(dist, 'api/dashboard.md'), 'utf8').includes(spec.info.title));
assert(readFileSync(join(dist, 'llms.txt'), 'utf8').includes('dashboard.openapi.json'));
assert(!JSON.stringify(spec).includes('../../spec/'), 'Downloadable OpenAPI must resolve without repository files');
console.log('check-openapi-dist: seven HTTP operations have HTML, Markdown, agent indexes and a bundled specification');
