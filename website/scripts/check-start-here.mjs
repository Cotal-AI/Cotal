import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertPlainMarkdown } from './assert-plain-markdown.mjs';

const artifact = (path) =>
  readFileSync(new URL(`../dist/${path}`, import.meta.url), 'utf8');
const pages = JSON.parse(
  readFileSync(new URL('../src/generated/pages.json', import.meta.url)),
);
const quickstart = artifact('docs/getting-started/index.html');
assert(
  /class="[^"]*fd-steps/.test(quickstart),
  'Quickstart renders native Fumadocs steps',
);
for (const id of [
  '1-prepare-a-project',
  '2-start-a-local-mesh',
  '3-launch-your-agent',
  '4-check-the-mesh',
  '5-stop-the-tutorial',
]) assert(quickstart.includes(`id="${id}"`), `stable tutorial anchor: ${id}`);
assert(
  quickstart.includes('data-card="true"'),
  'next steps render native Fumadocs cards',
);
for (const label of [
  'Operate a mesh',
  'Connect agents',
  'Build integrations',
  'Fundamentals',
  'Messaging',
  'Security',
  'Agent coordination',
]) {
  assert(quickstart.includes(label), `sidebar includes ${label}`);
}
for (const slug of [
  'what-is-cotal',
  'installation',
  'getting-started',
  'examples',
  'setup',
]) {
  const markdown = artifact(`docs/${slug}.md`);
  assertPlainMarkdown(markdown, slug);
}
for (const slug of ['what-is-cotal', 'installation', 'getting-started', 'examples']) {
  const source = readFileSync(new URL(`../../docs/${slug}.mdx`, import.meta.url), 'utf8');
  const markdown = artifact(`docs/${slug}.md`);
  assert(/^---\n/.test(source), `authored frontmatter: ${slug}`);
  assert(/^kind: /m.test(source) && /^audience: /m.test(source), `classification metadata: ${slug}`);
  assert(!/^> Informative/m.test(markdown), `classification stays out of prose: ${slug}`);
  for (const [, title, href] of source.matchAll(/<Card title="([^"]+)" href="([^"]+)">/g)) {
    assert(markdown.includes(`[${title}](`), `card title in Markdown: ${slug}/${title}`);
    const target = pages.find(page => page.slug === href.replace(/\.mdx?$/, '').toLowerCase());
    assert(target && markdown.includes(`](${target.url})`), `card destination in Markdown: ${slug}/${href}`);
  }
}
const shutdown = artifact('docs/getting-started.md');
assert(shutdown.includes('stops the local stack and deprovisions its managed agents'), 'shutdown warning is exported');
assert(shutdown.indexOf('stops the local stack') < shutdown.indexOf('cotal down --with-agents'), 'shutdown warning precedes command');
const setup = artifact('docs/setup.md');
for (const command of [
  'npx cotal-ai setup --destination local --harness claude --project . --space main --no-input',
  'npx cotal-ai up --root . --space main --detach',
]) {
  assert(
    setup.includes(command),
    `automation command remains documented: ${command}`,
  );
}
console.log(
  'check-start-here: native tutorial steps, subsection labels, plain Markdown and setup commands verified',
);

const { navigation } = await import('../src/generated/navigation.mjs');
const homes = new Map();
const collect = (nodes, path) => {
  for (const node of nodes) {
    if (node.kind === 'group') collect(node.children, [...path, node.title]);
    else {
      assert(!homes.has(node.url), `one navigation home: ${node.url}`);
      homes.set(node.url, path.join(' / '));
    }
  }
};
for (const section of navigation) collect(section.children, [section.title]);
assert.equal(homes.size, pages.length);
for (const page of pages)
  assert(homes.has(page.url), `navigation includes ${page.url}`);
assert.equal(homes.get('/docs/installation/'), 'Docs / Start here');
assert.equal(homes.get('/docs/examples/'), 'Docs / Start here');
assert.equal(homes.get('/docs/setup/'), 'Docs / Guides / Operate a mesh');
assert.equal(
  homes.get('/docs/connect-codex/'),
  'Docs / Guides / Connect agents',
);
assert.equal(
  homes.get('/docs/authoring-a-connector/'),
  'Docs / Guides / Build integrations',
);
const reference = new Set([
  'overview',
  ...Object.values(JSON.parse(readFileSync(new URL('./fixtures/cli-fragments.json', import.meta.url), 'utf8'))),
  'cli',
  'mcp-tools',
  'agent-files',
  'manifest',
  'channels-and-permissions',
  'config',
  'mesh-view',
  'lang-card',
  'glossary',
]);
for (const page of pages)
  assert.equal(
    page.url,
    `/${reference.has(page.slug) ? 'api-reference' : 'docs'}/${page.slug}/`,
    `stable public route: ${page.slug}`,
  );
console.log(
  `check-start-here: ${homes.size} pages have one navigation home and stable routes`,
);
