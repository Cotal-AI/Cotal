import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'parse5';
import { assertPlainMarkdown } from './assert-plain-markdown.mjs';

const artifact = path => readFileSync(new URL(`../dist/${path}`, import.meta.url), 'utf8');
const destinations = new Map([
  ['split-host-bind', 'remote-supervision'],
  ['remote-supervised-seats-by-enrollment', 'remote-supervision'],
  ['supervising-the-detached-stack', 'supervise-processes'],
  ['remote-supervised-agents', 'remote-supervision'],
  ['spawning-agents', 'launch-agents'],
  ['mesh-registry', 'register-a-mesh'],
  ['meshes-you-did-not-start-here', 'register-a-mesh'],
  ['which-addresses-you-may-register', 'register-a-mesh'],
  ['registering-a-hosted-user-auth-mesh', 'register-a-mesh'],
  ['watching', 'watch-a-mesh'],
  ['offline-backup', 'backup-a-mesh'],
  ['personas-from-the-cli', 'launch-agents'],
  ['gate-recovery', 'recover-a-mesh'],
  ['last-resort-jetstream-store-replacement', 'recover-a-mesh'],
  ['when-something-looks-absent', 'recover-a-mesh'],
]);
const slugs = ['setup', 'run-a-mesh', 'launch-agents', 'define-a-team', 'register-a-mesh', 'watch-a-mesh', 'console', 'web-dashboard', 'remote-supervision', 'supervise-processes', 'deploy', 'backup-a-mesh', 'recover-a-mesh', 'upgrade-cotal'];
const legacyAnchors = JSON.parse(readFileSync(new URL('./fixtures/operate-legacy-anchors.json', import.meta.url), 'utf8'));
const attr = (node, name) => node.attrs?.find(attribute => attribute.name === name)?.value;
const elements = (node, result = []) => {
  if (node.tagName) result.push(node);
  for (const child of node.childNodes ?? []) elements(child, result);
  return result;
};
const findArticle = tree => elements(tree).find(node => attr(node, 'id') === 'nd-page');
const articles = new Map(slugs.map(slug => [slug, elements(findArticle(parse(artifact(`docs/${slug}/index.html`))))]));
for (const [slug, ids] of Object.entries(legacyAnchors)) {
  const nodes = articles.get(slug) ?? elements(findArticle(parse(artifact(`docs/${slug}/index.html`))));
  for (const id of ids) assert.equal(nodes.filter(node => attr(node, 'id') === id).length, 1, `preserved fragment: ${slug}/#${id}`);
}
const local = articles.get('run-a-mesh');
for (const id of ['the-stack', 'history', ...destinations.keys()]) {
  assert.equal(local.filter(node => attr(node, 'id') === id).length, 1, `legacy section exists once: ${id}`);
}
for (const [id, slug] of destinations) {
  const start = local.findIndex(node => attr(node, 'id') === id);
  const end = local.findIndex((node, index) => index > start && /^h[2-6]$/.test(node.tagName));
  const section = local.slice(start, end === -1 ? undefined : end);
  const links = section.filter(node => node.tagName === 'a').map(node => attr(node, 'href'));
  assert(links.some(href => href?.startsWith(`/docs/${slug}/`)), `legacy section links to its focused guide: ${id}`);
}
for (const [slug, nodes] of articles) {
  assert.equal(nodes.filter(node => node.tagName === 'h1').length, 1, `one page title: ${slug}`);
  for (const node of nodes) {
    const href = attr(node, 'href');
    if (!href || node.tagName !== 'a') continue;
    const url = new URL(href, `https://docs.cotal.ai/docs/${slug}/`);
    const target = url.pathname.match(/^\/docs\/([^/]+)\/$/)?.[1];
    if (url.origin !== 'https://docs.cotal.ai' || !articles.has(target) || !url.hash) continue;
    assert(articles.get(target).some(element => attr(element, 'id') === decodeURIComponent(url.hash.slice(1))), `${slug} links to an existing focused section: ${href}`);
  }
  const markdown = artifact(`docs/${slug}.md`);
  assert(markdown.startsWith('# '), `Markdown has its title: ${slug}`);
  assertPlainMarkdown(markdown, slug);
  assert(!/^> \*\*Guide\*\*|^> Informative/m.test(markdown), `classification stays in metadata: ${slug}`);
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
for (const slug of slugs) assert.equal(homes.get(`/docs/${slug}/`), 'Docs / Guides / Operate a mesh');
console.log(`check-operate-mesh: ${slugs.length} operator guides, ${Object.values(legacyAnchors).flat().length} preserved fragments, forwarding links, Markdown and navigation verified`);
