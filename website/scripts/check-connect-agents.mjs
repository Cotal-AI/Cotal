import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'parse5';
import { lexer, walkTokens } from 'marked';
import { connectorIcons } from '../src/lib/connector-icons.mjs';

const artifact = path => readFileSync(new URL(`../dist/${path}`, import.meta.url), 'utf8');
const anchors = JSON.parse(readFileSync(new URL('./fixtures/connect-legacy-anchors.json', import.meta.url), 'utf8'));
const guides = Object.keys(anchors);
const references = ['connector-runtime-reference', ...['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi'].map(name => `${name}-connector-reference`)];
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
  const prose = [];
  walkTokens(lexer(markdown), token => {
    if (token.type === 'html' || (token.type === 'text' && !token.tokens)) prose.push(token.raw);
  });
  assert(!/^import |^export |<\/?(?:Cards?|Steps?|Tabs?|Callout)\b/m.test(prose.join('\n')), `complete plain Markdown: ${slug}`);
  assert(!markdown.includes('\0'), `Markdown has no NUL: ${slug}`);
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
    assert(articles.get(target).some(element => attr(element, 'id') === decodeURIComponent(url.hash.slice(1))), `${slug} links to an existing connector section: ${href}`);
  }
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
for (const slug of guides) assert.equal(homes.get(`/docs/${slug}/`), 'Docs / Guides / Connect agents');
for (const slug of references) assert.equal(homes.get(`/docs/${slug}/`), 'Docs / Guides / Build integrations / Connector reference');
const sidebar = elements(parse(artifact('docs/connectors/index.html'))).find(node => attr(node, 'id') === 'nd-sidebar');
assert(sidebar, 'native docs sidebar');
for (const [slug, src] of connectorIcons) {
  const links = elements(sidebar).filter(node => node.tagName === 'a' && attr(node, 'href') === `/docs/${slug}/`);
  assert.equal(links.length, 1, `one sidebar link: ${slug}`);
  const images = elements(links[0]).filter(node => node.tagName === 'img');
  assert.equal(images.length, 1, `one sidebar icon: ${slug}`);
  assert.equal(attr(images[0], 'src'), src);
  assert.equal(attr(images[0], 'alt'), '');
  assert.equal(attr(images[0], 'aria-hidden'), 'true');
  assert(readFileSync(new URL(`../dist${src}`, import.meta.url)).length > 0, `local icon exists: ${slug}`);
}
console.log(`check-connect-agents: ${guides.length} guides, ${references.length} references, ${Object.values(anchors).flat().length} legacy fragments, connector icons, Markdown and navigation verified`);
