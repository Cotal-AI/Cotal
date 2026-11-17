import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { parse } from 'parse5';

// TypeDoc writes the TypeScript reference (`pnpm gen:tsdocs`) and sync publishes it at /api/typescript/.
const dist = new URL('../dist/', import.meta.url);
const reference = new URL('api/typescript/', dist);
const repoRoot = new URL('../../', import.meta.url);
const read = url => readFileSync(url, 'utf8');

// TypeDoc's own navigation data lists each package, module and declaration page it wrote.
const encoded = /^window\.navigationData = "([A-Za-z0-9+/=]+)"/.exec(read(new URL('assets/navigation.js', reference)));
assert(encoded, 'TypeDoc navigation data');
const navigation = JSON.parse(inflateSync(Buffer.from(encoded[1], 'base64')).toString('utf8'));
const packages = new Map();
const visit = (nodes, scope) => {
  for (const node of nodes) {
    if (!node.path) visit(node.children ?? [], `${scope}${node.text}/`);
    else packages.set(`${scope}${node.text}`, node);
  }
};
visit(navigation, '');

// Every import path of every documented package has a module page.
const { entryPoints } = JSON.parse(read(new URL('typedoc.json', repoRoot)));
assert.equal(packages.size, entryPoints.length, 'one navigation entry per TypeDoc entry point');
let importPaths = 0;
for (const dir of entryPoints) {
  const manifest = JSON.parse(read(new URL(`${dir}/package.json`, repoRoot)));
  const pkg = packages.get(manifest.name);
  assert(pkg, `TypeScript reference lists ${manifest.name}`);
  const keys = Object.keys(manifest.exports ?? { '.': manifest.main });
  const modules = pkg.children?.filter(node => node.kind === 2) ?? [];
  if (keys.length === 1) assert.equal(modules.length, 0, `${manifest.name} is documented as one module`);
  else {
    const names = keys.map(key => key === '.' ? 'index' : key.slice(2)).sort();
    assert.deepEqual(modules.map(node => node.text).sort(), names, `${manifest.name} has one module per import path`);
  }
  importPaths += keys.length;
}

// Every page TypeDoc lists exists, and every link inside the reference or into the site lands on
// an existing page and, when it names one, an existing anchor.
const pages = new Map();
const walk = url => {
  for (const entry of readdirSync(url, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
    if (entry.isDirectory()) walk(child);
    else if (entry.name.endsWith('.html')) pages.set(child.href, parse(read(child)));
  }
};
walk(reference);
const elements = (node, result = []) => {
  if (node.tagName) result.push(node);
  for (const child of (node.content ?? node).childNodes ?? []) elements(child, result);
  return result;
};
const attr = (node, name) => node.attrs?.find(attribute => attribute.name === name)?.value;
const ids = new Map();
const idsOf = href => {
  if (!ids.has(href)) ids.set(href, new Set(elements(pages.get(href) ?? parse(read(new URL(href)))).map(node => attr(node, 'id')).filter(Boolean)));
  return ids.get(href);
};
let listed = 0;
const listedPages = nodes => {
  for (const node of nodes) {
    if (node.path) {
      const url = new URL(node.path, reference);
      const file = url.href.replace(/#.*$/, '');
      assert(pages.has(file), `navigation page exists: ${node.path}`);
      if (url.hash) assert(idsOf(file).has(decodeURIComponent(url.hash.slice(1))), `navigation anchor exists: ${node.path}`);
      listed++;
    }
    listedPages(node.children ?? []);
  }
};
listedPages(navigation);
let links = 0;
for (const [href, document] of pages) {
  for (const node of elements(document)) {
    const target = node.tagName === 'a' && attr(node, 'href');
    if (!target || target === '#') continue;
    // A site-root path is served from the built site, not the filesystem root.
    const url = /^\/(?!\/)/.test(target) ? new URL(target.slice(1), dist) : new URL(target, href);
    if (url.protocol !== 'file:') continue;
    let file = url.href.replace(/[?#].*$/, '');
    if (file.endsWith('/')) file += 'index.html';
    assert(file.startsWith(dist.href) && existsSync(new URL(file)) && statSync(new URL(file)).isFile(), `link target exists: ${href.slice(dist.href.length)} -> ${target}`);
    if (url.hash && file.endsWith('.html')) assert(idsOf(file).has(decodeURIComponent(url.hash.slice(1))), `link anchor exists: ${href.slice(dist.href.length)} -> ${target}`);
    links++;
  }
}
console.log(`check-typescript-reference: ${packages.size} packages, ${importPaths} import paths, ${listed} listed pages, ${pages.size} HTML files, ${links} links verified`);
