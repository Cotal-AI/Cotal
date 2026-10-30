import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'parse5';
import { assertPlainMarkdown } from './assert-plain-markdown.mjs';

const artifact = path => readFileSync(new URL(`../dist/${path}`, import.meta.url), 'utf8');
const anchors = JSON.parse(readFileSync(new URL('./fixtures/integration-legacy-anchors.json', import.meta.url), 'utf8'));
const guides = Object.keys(anchors);
const references = ['exports', 'remote-clients', 'daemons', 'provisioning', 'service-authority', 'manager', 'delegated-seats'].map(name => `embedding-${name}`);
const attr = (node, name) => node.attrs?.find(attribute => attribute.name === name)?.value;
const elements = (node, result = []) => {
  if (node.tagName) result.push(node);
  for (const child of node.childNodes ?? []) elements(child, result);
  return result;
};
const articles = new Map();
for (const slug of [...guides, ...references]) {
  const tree = elements(parse(artifact(`docs/${slug}/index.html`)));
  const article = tree.find(node => attr(node, 'id') === 'nd-page');
  assert(article, `rendered article: ${slug}`);
  const nodes = elements(article);
  articles.set(slug, nodes);
  assert.equal(nodes.filter(node => node.tagName === 'h1').length, 1, `one page title: ${slug}`);
  for (const id of anchors[slug] ?? [])
    assert.equal(nodes.filter(node => attr(node, 'id') === id).length, 1, `preserved fragment: ${slug}/#${id}`);
  const markdown = artifact(`docs/${slug}.md`);
  assert(markdown.startsWith('# '), `Markdown title: ${slug}`);
  assertPlainMarkdown(markdown, slug);
  assert(!/^> \*\*Guide\*\*|^> Informative/m.test(markdown), `classification stays in metadata: ${slug}`);
}
for (const [slug, nodes] of articles) {
  for (const node of nodes) {
    if (node.tagName !== 'a') continue;
    const href = attr(node, 'href');
    if (!href) continue;
    const url = new URL(href, `https://docs.cotal.ai/docs/${slug}/`);
    const target = url.pathname.match(/^\/docs\/([^/]+)\/$/)?.[1];
    if (url.origin !== 'https://docs.cotal.ai' || !articles.has(target) || !url.hash) continue;
    assert(articles.get(target).some(element => attr(element, 'id') === decodeURIComponent(url.hash.slice(1))), `${slug} links to an existing integration section: ${href}`);
  }
}
const forwarding = new Map([
  ['interactive-manager-primary', 'manager'],
  ['account-connection-census', 'service-authority'],
  ['service-authority-contracts', 'service-authority'],
  ['owner-bound-platform-supervisors', 'service-authority'],
  ['the-export-surface', 'exports'],
  ['remote-mcp-gateway', 'remote-clients'],
  ['private-tool-results', 'remote-clients'],
  ['browser-control', 'remote-clients'],
  ['remote-manager-client-composition', 'remote-clients'],
  ['long-lived-endpoints-take-a-bearer-function', 'exports'],
  ['booting-the-daemons', 'daemons'],
  ['auth-service', 'daemons'],
  ['delivery', 'daemons'],
  ['supervisor-signing-authority', 'manager'],
  ['delegated-seats-outside-the-managers-filesystem', 'delegated-seats'],
  ['delegated-recovery-contracts', 'delegated-seats'],
  ['provisioning-a-space-one-space-reference-shape', 'provisioning'],
  ['hazardous-provisioning-primitives', 'provisioning'],
  ['hosted-composition-gaps', 'provisioning'],
  ['hosted-durability', 'provisioning'],
  ['hosted-run-revocation', 'service-authority'],
  ['private-tool-result-prerequisites-not-serving', 'service-authority'],
  ['native-service-custody-guards', 'service-authority'],
]);
const entry = articles.get('embedding');
for (const [id, topic] of forwarding) {
  const start = entry.findIndex(node => attr(node, 'id') === id);
  const end = entry.findIndex((node, index) => index > start && /^h[2-6]$/.test(node.tagName));
  const section = entry.slice(start, end === -1 ? undefined : end);
  assert(section.some(node => node.tagName === 'a' && attr(node, 'href')?.startsWith(`/docs/embedding-${topic}/`)), `legacy section forwards to its reference: ${id}`);
}
const { navigation } = await import('../src/generated/navigation.mjs');
const homes = new Map();
const visit = (nodes, path) => {
  for (const node of nodes) {
    if (node.kind === 'group') visit(node.children, [...path, node.title]);
    else {
      assert(!homes.has(node.url), `one navigation home: ${node.url}`);
      homes.set(node.url, path.join(' / '));
    }
  }
};
for (const section of navigation) visit(section.children, [section.title]);
for (const slug of guides) assert.equal(homes.get(`/docs/${slug}/`), 'Docs / Guides / Build integrations');
for (const slug of references) assert.equal(homes.get(`/docs/${slug}/`), 'Docs / Guides / Build integrations / Embedding reference');
console.log(`check-build-integrations: ${guides.length} guides, ${references.length} references, ${Object.values(anchors).flat().length} legacy fragments, Markdown and navigation verified`);
