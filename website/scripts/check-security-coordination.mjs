import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'parse5';
import { readDocument } from '@cotal-ai/docs-content';
import { assertPlainMarkdown } from './assert-plain-markdown.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const artifact = path => read(`../dist/${path}`);
const { concepts, references } = JSON.parse(read('./fixtures/security-coordination.json'));
const documents = [
  ...Object.entries(concepts).map(([slug, { group, ids }]) => ({ slug, group, ids, kind: 'Concept' })),
  ...references.map(({ slug, group }) => ({ slug, group, ids: [], kind: 'Reference' })),
];
assert.equal(new Set(documents.map(document => document.slug)).size, documents.length, 'distinct affected documents');
const groups = new Set(Object.values(concepts).map(concept => concept.group));
for (const { slug, group } of references) assert(groups.has(group), `reference concept group: ${slug}`);
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
for (const { slug, kind, ids } of documents) {
  const route = `docs/${slug}`;
  const nodes = article(route);
  assert.equal(nodes.filter(node => node.tagName === 'h1').length, 1, `one title: ${slug}`);
  for (const id of ids)
    assert.equal(nodes.filter(node => attr(node, 'id') === id).length, 1, `preserved fragment: ${slug}/#${id}`);
  const source = await readDocument(new URL(`../../docs/${slug}.mdx`, import.meta.url).pathname);
  assert.equal(source.format, 'mdx', `direct MDX: ${slug}`);
  assert.equal(source.metadata.kind, kind, `document mode: ${slug}`);
  assert(source.metadata.audience, `audience metadata: ${slug}`);
  const markdown = artifact(`${route}.md`);
  assert(markdown.startsWith(`# ${source.metadata.title}\n\n`), `complete Markdown title: ${slug}`);
  assertPlainMarkdown(markdown, slug);
  assert(!/^> \*\*(?:Concept|Reference)\*\*/m.test(markdown), `classification outside prose: ${slug}`);
  for (const node of nodes) {
    const href = node.tagName === 'a' && attr(node, 'href');
    if (!href) continue;
    const url = new URL(href, `https://docs.cotal.ai/${route}/`);
    if (url.origin !== 'https://docs.cotal.ai' || !url.hash) continue;
    const target = url.pathname.match(/^\/(docs|api-reference)\/([^/]+)\/?$/);
    if (!target) continue;
    const id = decodeURIComponent(url.hash.slice(1));
    assert.equal(article(`${target[1]}/${target[2]}`).filter(element => attr(element, 'id') === id).length, 1, `valid linked section: ${slug}/${href}`);
  }
}
const { navigation } = await import('../src/generated/navigation.mjs');
const homes = new Map(documents.map(({ slug }) => [`/docs/${slug}/`, []]));
const visit = (nodes, path) => {
  for (const node of nodes) {
    if (node.kind === 'group') visit(node.children, [...path, node.title]);
    else homes.get(node.url)?.push(path);
  }
};
for (const root of navigation) visit(root.children, [root.title]);
for (const { slug, group, kind } of documents) {
  const expected = ['Docs', 'Concepts', group];
  if (kind === 'Reference') expected.push('Reference');
  assert.deepEqual(homes.get(`/docs/${slug}/`), [expected], `unique navigation home: ${slug}`);
}
console.log(`check-security-coordination: ${Object.keys(concepts).length} concepts, ${references.length} references, ${Object.values(concepts).flatMap(concept => concept.ids).length} legacy fragments, direct MDX, Markdown, linked sections and navigation verified`);
