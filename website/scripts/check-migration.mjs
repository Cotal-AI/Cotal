import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'parse5';
const pages = JSON.parse(readFileSync(new URL('../src/generated/pages.json', import.meta.url)));
const redirects = readFileSync(new URL('../dist/_redirects', import.meta.url), 'utf8');
assert(pages.length > 35, 'all existing pages are published');
assert.equal(new Set(pages.map(p => p.url)).size, pages.length);
for (const page of pages) {
  const htmlFile = new URL(`../dist${page.url}index.html`, import.meta.url);
  assert(existsSync(htmlFile), `HTML: ${page.url}`);
  assert.equal(readFileSync(new URL(`../dist${page.url.slice(0,-1)}.md`, import.meta.url), 'utf8'), page.markdown, `Markdown: ${page.url}`);
  if (page.section !== 'api' && page.slug !== 'api-reference')
    assert(redirects.includes(`/${page.slug}/ ${page.url} 301`), `legacy redirect: ${page.slug}`);
  const document = parse(readFileSync(htmlFile, 'utf8'));
  const elements = [];
  const collect = node => { elements.push(node); for (const child of node.childNodes ?? []) collect(child); };
  collect(document);
  assert(elements.some(node => node.nodeName === 'button' && node.attrs?.some(attr => attr.name === 'aria-label' && attr.value === 'Copy page')), `Copy page: ${page.url}`);
  assert(elements.some(node => node.nodeName === 'link' && node.attrs?.some(attr => attr.name === 'rel' && attr.value === 'icon') && node.attrs?.some(attr => attr.name === 'href' && attr.value === '/favicon.svg')), `favicon: ${page.url}`);
  const visit = node => {
    for (const attr of node.attrs ?? []) {
      if (!['href','src'].includes(attr.name)) continue;
      const url = new URL(attr.value, `https://docs.cotal.ai${page.url}`);
      if (url.origin !== 'https://docs.cotal.ai' || url.pathname === '/') continue;
      if (redirects.split('\n').some(line => line.split(' ')[0] === url.pathname)) continue;
      assert(existsSync(new URL(`../dist${url.pathname}`, import.meta.url)), `${page.url} links to missing ${url.pathname}`);
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
}
assert.equal(pages.find(p => p.slug === 'cli').url, '/api-reference/cli/');
assert.equal(pages.find(p => p.slug === 'spec').url, '/docs/spec/');
console.log(`check-migration: ${pages.length} pages, Markdown twins, legacy redirects and local links verified`);
