import assert from 'node:assert/strict';
import { parse } from 'parse5';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpReferences, referenceOperations } from './http-api.mjs';
import { httpSidebarTitles } from './http-navigation.mjs';

const website = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(website, 'dist');
const sidebar = readFileSync(join(website, 'src/generated/navigation.mjs'), 'utf8');
const redirects = readFileSync(join(dist, '_redirects'), 'utf8');
const apiOverview = readFileSync(join(dist, 'api-reference/api-reference/index.html'), 'utf8');
const textOf = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(textOf).join('');
const find = (node, predicate) => predicate(node) ? node : (node.childNodes ?? []).map(child => find(child, predicate)).find(Boolean);
const attribute = (node, name) => node.attrs?.find(attr => attr.name === name)?.value;
let count = 0;
for (const reference of httpReferences) {
  const { id, base, docSlug, specFile } = reference;
  assert(existsSync(join(dist, base, 'index.html')), `${id} OpenAPI overview must be published`);
  for (const alias of [`/${docSlug}`, `/${docSlug}/`]) {
    assert(redirects.includes(`${alias} /${base}/ 301`), `${id} source route must redirect to the canonical reference`);
  }
  assert(!existsSync(join(dist, `${docSlug}/index.html`)), 'Aliases must not render another reference');
  assert(!existsSync(join(dist, `${docSlug}.md`)), 'Only the canonical API URL publishes the complete Markdown reference');
  assert(!sidebar.includes(docSlug), 'Generated sources must stay out of human navigation');
  assert(!apiOverview.includes(`href="/${docSlug}/"`), 'The overview must link directly to the HTTP reference');
  assert(apiOverview.includes(`href="/${base}/"`), `Missing canonical ${id} entry point`);
  const spec = JSON.parse(readFileSync(join(dist, specFile), 'utf8'));
  const complete = readFileSync(join(dist, `${base}.md`), 'utf8');
  const overview = parse(readFileSync(join(dist, base, 'index.html'), 'utf8'));
  const overviewSidebar = find(overview, node => attribute(node, 'id') === 'nd-sidebar');
  const overviewLink = overviewSidebar && find(overviewSidebar, node => node.tagName === 'a' && attribute(node, 'href')?.replace(/\/$/, '') === `/${base}`);
  assert(overviewLink && textOf(overviewLink).trim() === 'Overview', `Concise overview navigation: ${id}`);
  for (const title of ['Connection', 'Authentication', 'Reference downloads']) {
    assert(find(overview, node => node.tagName === 'h2' && find(node, child => child.tagName === 'a' && textOf(child).trim() === title)), `Overview entry information missing: ${id}/${title}`);
  }
  const schemaLinks = find(overview, node => node.tagName === 'details' && find(node, child => child.tagName === 'summary' && textOf(child) === 'Schema reference links'));
  assert(schemaLinks && !schemaLinks.attrs?.some(attr => attr.name === 'open'), `Legacy schema links must be collapsed: ${id}`);
  for (const [name, schema] of Object.entries(spec.components.schemas).filter(([name]) => !name.startsWith('Wire'))) {
    assert(find(schemaLinks, node => node.tagName === 'h3' && find(node, child => child.tagName === 'a' && textOf(child).trim() === name)), `Legacy schema anchor: ${id}/${name}`);
    assert(complete.includes(JSON.stringify(schema, null, 2)), `Complete Markdown schema body: ${id}/${name}`);
    assert(!find(overview, node => node.tagName === 'pre' && textOf(node).trim() === JSON.stringify(schema, null, 2)), `Overview must not dump raw schema JSON: ${id}/${name}`);
  }
  const operations = referenceOperations(spec);
  for (const operation of operations) {
    const slug = `${base}/operations/${operation.operationId}`;
    const html = readFileSync(join(dist, slug, 'index.html'), 'utf8');
    const document = parse(html);
    assert(!find(document, node => attribute(node, 'id') === 'nd-toc-placeholder'), `Full-width API page must not reserve an empty TOC column: ${operation.operationId}`);
    assert(find(document, node => node.tagName === 'h1' && textOf(node).trim() === operation.summary), `Readable page heading changed: ${operation.operationId}`);
    const desktopSidebar = find(document, node => attribute(node, 'id') === 'nd-sidebar');
    const sidebarLink = desktopSidebar && find(desktopSidebar, node => node.tagName === 'a' && attribute(node, 'href')?.replace(/\/$/, '') === `/${slug}`);
    assert(sidebarLink, `HTTP sidebar link missing: ${operation.operationId}`);
    const sidebarTitle = httpSidebarTitles[id][operation.operationId];
    assert.equal(textOf(sidebarLink).replace(/\s+/g, ' ').trim(), `${sidebarTitle} ${operation.method}`, `HTTP sidebar label and method: ${operation.operationId}`);
    assert(find(sidebarLink, node => node.tagName === 'span' && textOf(node) === operation.method && attribute(node, 'class')?.split(' ').includes('ms-auto')), `Native HTTP method badge missing: ${operation.operationId}`);
    const native = find(document, node => attribute(node, 'data-native-openapi') === id);
    assert(native, `Native OpenAPI renderer missing: ${operation.operationId}`);
    const nativeText = textOf(native);
    assert(nativeText.includes(operation.path), `Native endpoint path missing: ${operation.operationId}`);
    assert(nativeText.toUpperCase().includes(operation.method), `Native endpoint method missing: ${operation.operationId}`);
    assert(nativeText.includes('Response Body'), `Native response schemas missing: ${operation.operationId}`);
    if (operation.requestBody) assert(nativeText.includes('Body'), `Native request schema missing: ${operation.operationId}`);
    for (const status of Object.keys(operation.responses)) {
      assert(find(native, node => attribute(node, 'role') === 'tab' && textOf(node) === status), `Native response selector missing: ${operation.operationId}/${status}`);
    }
    assert(find(native, node => attribute(node, 'aria-label') === 'Code language'), `Native request examples missing: ${operation.operationId}`);
    const legacy = find(document, node => node.tagName === 'details' && find(node, child => child.tagName === 'summary' && textOf(child) === 'Complete HTTP contract'));
    assert(legacy && !legacy.attrs?.some(attr => attr.name === 'open'), `Complete contract is collapsed: ${operation.operationId}`);
    assert(find(legacy, node => attribute(node, 'id') === operation.operationId), `Stable operation anchor: ${operation.operationId}`);
    assert(html.includes(`/${slug}.md`), `HTML must advertise its Markdown twin: ${slug}`);
    assert(complete.includes(operation.path) && complete.includes('## Schemas'), 'Canonical Markdown must include the full reference');
    const markdown = readFileSync(join(dist, `${slug}.md`), 'utf8');
    assert(markdown.includes(operation.path), `Markdown lost ${operation.path}`);
    if (operation.requestBody) assert(markdown.includes('### Request body'), `Markdown lost request: ${operation.operationId}`);
    if (operation['x-sse-events']) {
      assert(find(document, node => attribute(node, 'id') === 'native-event-payloads'), `SSE payload supplement missing: ${operation.operationId}`);
      for (const event of Object.keys(operation['x-sse-events'])) assert(markdown.includes(event), `Markdown lost SSE event: ${event}`);
    }
    for (const file of ['llms-full.txt', 'llms-small.txt']) assert(readFileSync(join(dist, file), 'utf8').includes(operation.path), `${file} lost ${operation.path}`);
  }
  assert(complete.includes(spec.info.title));
  assert(readFileSync(join(dist, 'llms.txt'), 'utf8').includes(specFile));
  assert(!JSON.stringify(spec).includes('../../spec/'), 'Downloads must resolve without repository files');
  count += operations.length;
}
console.log(`check-openapi-dist: ${count} HTTP operations have native UI, Markdown, agent indexes and bundled specifications`);
