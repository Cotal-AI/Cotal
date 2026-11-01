import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'parse5';
import { readDocument } from '@cotal-ai/docs-content';
import { assertPlainMarkdown } from './assert-plain-markdown.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const artifact = path => read(`../dist/${path}`);
const configuration = JSON.parse(read('./fixtures/configuration-anchors.json'));
const models = JSON.parse(read('./fixtures/models-anchors.json'));
const legacy = { ...JSON.parse(read('./fixtures/api-reference-anchors.json')), ...configuration, ...models };
const cli = JSON.parse(read('./fixtures/cli-fragments.json'));
const focused = [...new Set(Object.values(cli))];
const slugs = ['overview', 'api-reference', 'cli', 'mcp-tools', ...focused, ...Object.keys(configuration), ...Object.keys(models)];
const attr = (node, name) => node.attrs?.find(attribute => attribute.name === name)?.value;
const elements = (node, result = []) => {
  if (node.tagName) result.push(node);
  for (const child of node.childNodes ?? []) elements(child, result);
  return result;
};
const articles = new Map();
for (const slug of slugs) {
  const tree = elements(parse(artifact(`api-reference/${slug}/index.html`)));
  const article = tree.find(node => attr(node, 'id') === 'nd-page');
  assert(article, `rendered reference: ${slug}`);
  const nodes = elements(article);
  articles.set(slug, nodes);
  assert.equal(nodes.filter(node => node.tagName === 'h1').length, 1, `one title: ${slug}`);
  for (const id of legacy[slug] ?? [])
    assert.equal(nodes.filter(node => attr(node, 'id') === id).length, 1, `legacy fragment: ${slug}/#${id}`);
  const markdown = artifact(`api-reference/${slug}.md`);
  assert(markdown.startsWith('# '), `Markdown title: ${slug}`);
  assertPlainMarkdown(markdown, slug);
  assert(!/^> \*\*Reference\*\*/m.test(markdown), `classification outside prose: ${slug}`);
  const document = await readDocument(new URL(`../../docs/${slug}.mdx`, import.meta.url).pathname);
  assert.equal(document.format, 'mdx', `direct MDX reference: ${slug}`);
  assert.equal(document.metadata.kind, 'Reference', `reference metadata: ${slug}`);
  assert(document.metadata.audience, `audience metadata: ${slug}`);
  if (Object.hasOwn(configuration, slug) || slug === 'mesh-view' || slug === 'lang-card') {
    assert(nodes.some(node => node.tagName === 'table'), `native reference tables: ${slug}`);
  }
}
for (const [slug, nodes] of articles) {
  for (const node of nodes) {
    if (node.tagName !== 'a') continue;
    const href = attr(node, 'href');
    if (!href) continue;
    const url = new URL(href, `https://docs.cotal.ai/api-reference/${slug}/`);
    const target = url.pathname.match(/^\/api-reference\/([^/]+)\/$/)?.[1];
    if (url.origin !== 'https://docs.cotal.ai' || !articles.has(target) || !url.hash) continue;
    assert(articles.get(target).some(element => attr(element, 'id') === decodeURIComponent(url.hash.slice(1))), `valid reference fragment: ${slug}/${href}`);
  }
}
const index = articles.get('cli');
for (const [id, slug] of Object.entries(cli)) {
  assert.equal(index.filter(node => attr(node, 'id') === id).length, 1, `CLI index fragment: ${id}`);
  assert.equal(articles.get(slug).filter(node => attr(node, 'id') === id).length, 1, `focused CLI fragment: ${slug}/#${id}`);
  const start = index.findIndex(node => attr(node, 'id') === id);
  const end = index.findIndex((node, i) => i > start && /^h[2-6]$/.test(node.tagName));
  assert(index.slice(start, end === -1 ? undefined : end).some(node => node.tagName === 'a' && attr(node, 'href') === `/api-reference/${slug}/#${id}`), `CLI forwarding link: ${id}`);
}
const overviewCards = articles.get('overview').filter(node => node.tagName === 'a' && attr(node, 'data-card') === 'true');
assert.equal(overviewCards.length, 9, 'nine native API overview destinations');
assert.equal(index.filter(node => node.tagName === 'div' && attr(node, 'data-card') === 'true').length, 6, 'six native CLI groups without nested anchors');
for (const slug of focused) assert(artifact('api-reference/cli.md').includes(`](/api-reference/${slug}/)`), `CLI group links export: ${slug}`);
const { navigation } = await import('../src/generated/navigation.mjs');
const pages = JSON.parse(read('../src/generated/pages.json'));
assert.deepEqual(pages.filter(page => page.section === 'api-reference').map(page => page.slug).sort(), [...slugs].sort(), 'every published API reference is checked as direct MDX');
const homes = new Map();
const visit = (nodes, path) => {
  for (const node of nodes) {
    if (node.kind === 'group') visit(node.children, [...path, node.title]);
    else { assert(!homes.has(node.url)); homes.set(node.url, path); }
  }
};
for (const section of navigation) visit(section.children, [section.title]);
for (const slug of slugs) assert.equal(homes.get(`/api-reference/${slug}/`)?.[0], 'API Reference', `reference navigation home: ${slug}`);
for (const slug of focused) assert(homes.get(`/api-reference/${slug}/`).includes('CLI'), `CLI topic grouping: ${slug}`);
for (const slug of Object.keys(configuration)) assert(homes.get(`/api-reference/${slug}/`).includes('Configuration'), `configuration grouping: ${slug}`);
for (const slug of Object.keys(models)) assert(homes.get(`/api-reference/${slug}/`).includes('Models'), `models grouping: ${slug}`);
for (const path of ['/api-reference', '/api-reference/'])
  assert(artifact('_redirects').includes(`${path} /api-reference/api-reference/ 301`), 'legacy API root keeps its original document');
assert(artifact('_redirects').includes('/api-reference.md /api-reference/api-reference.md 301'), 'legacy HTML and Markdown resolve to the same document');
assert(artifact('api-reference/overview/index.html').includes('href="/api-reference/overview/"'), 'API tab opens overview');
console.log(`check-api-reference: ${slugs.length} direct MDX references, ${Object.values(legacy).flat().length} legacy fragments, native Cards, Markdown and navigation verified`);
