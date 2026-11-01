import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'parse5';
import { readDocument } from '@cotal-ai/docs-content';
import { assertPlainMarkdown } from './assert-plain-markdown.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const artifact = path => read(`../dist/${path}`);
const anchors = JSON.parse(read('./fixtures/fundamentals-anchors.json'));
const concepts = Object.keys(anchors);
const related = ['embedding-schema-inspection', 'connector-runtime-reference', 'control-surface', 'cli-installation', 'cli-processes', 'cli-maintenance', 'cli-observation', 'cli-shutdown', 'embedding-exports', 'embedding-daemons'];
const section = slug => slug.startsWith('cli-') ? 'api-reference' : 'docs';
const attr = (node, name) => node.attrs?.find(attribute => attribute.name === name)?.value;
const elements = (node, result = []) => {
  if (node.tagName) result.push(node);
  for (const child of node.childNodes ?? []) elements(child, result);
  return result;
};
const articles = new Map();
const article = path => {
  if (!articles.has(path)) {
    const nodes = elements(parse(artifact(`${path}/index.html`)));
    const page = nodes.find(node => attr(node, 'id') === 'nd-page');
    assert(page, `rendered article: ${path}`);
    articles.set(path, elements(page));
  }
  return articles.get(path);
};
for (const slug of [...concepts, ...related]) {
  const route = `${section(slug)}/${slug}`;
  const nodes = article(route);
  assert.equal(nodes.filter(node => node.tagName === 'h1').length, 1, `one title: ${slug}`);
  for (const id of anchors[slug] ?? [])
    assert.equal(nodes.filter(node => attr(node, 'id') === id).length, 1, `preserved fragment: ${slug}/#${id}`);
  const markdown = artifact(`${route}.md`);
  assert(markdown.startsWith('# '), `complete Markdown title: ${slug}`);
  assertPlainMarkdown(markdown, slug);
  if (concepts.includes(slug) || slug === 'embedding-schema-inspection') {
    assert(!/^> \*\*(?:Concept|Reference)\*\*/m.test(markdown), `classification outside prose: ${slug}`);
    const source = await readDocument(new URL(`../../docs/${slug}.mdx`, import.meta.url).pathname);
    assert.equal(source.format, 'mdx', `direct MDX: ${slug}`);
    assert.equal(source.metadata.kind, concepts.includes(slug) ? 'Concept' : 'Reference', `document mode: ${slug}`);
    assert(source.metadata.audience, `audience metadata: ${slug}`);
  }
  for (const node of nodes) {
    if (node.tagName !== 'a' || !attr(node, 'href')) continue;
    const url = new URL(attr(node, 'href'), `https://docs.cotal.ai/${route}/`);
    if (url.origin !== 'https://docs.cotal.ai' || !url.hash || !/^\/(docs|api-reference)\/[^/]+\/$/.test(url.pathname)) continue;
    assert(article(url.pathname.slice(1, -1)).some(target => attr(target, 'id') === decodeURIComponent(url.hash.slice(1))), `valid linked section: ${slug}/${url.href}`);
  }
}
assert(artifact('docs/architecture.md').includes('](/docs/embedding-schema-inspection/'), 'architecture links to the relocated schema contracts');
const { navigation } = await import('../src/generated/navigation.mjs');
const homes = new Map();
const visit = (nodes, path) => {
  for (const node of nodes) {
    if (node.kind === 'group') visit(node.children, [...path, node.title]);
    else { assert(!homes.has(node.url)); homes.set(node.url, path.join(' / ')); }
  }
};
for (const root of navigation) visit(root.children, [root.title]);
for (const slug of concepts) assert.equal(homes.get(`/docs/${slug}/`), 'Docs / Concepts / Fundamentals');
assert.equal(homes.get('/docs/embedding-schema-inspection/'), 'Docs / Guides / Build integrations / Embedding reference');
console.log(`check-fundamentals: ${concepts.length} concepts, ${Object.values(anchors).flat().length} legacy fragments, relocated reference contracts, Markdown, linked sections and navigation verified`);
