import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const artifact = (path) =>
  readFileSync(new URL(`../dist/${path}`, import.meta.url), 'utf8');
const quickstart = artifact('docs/getting-started/index.html');
assert(
  /class="[^"]*fd-steps/.test(quickstart),
  'Quickstart renders native Fumadocs steps',
);
assert(
  quickstart.includes('id="2-start-a-local-mesh"'),
  'tutorial source heading IDs survive step styling',
);
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
  assert(
    !/<(?:Steps?|Cards?|Callout|AgentPrompt)\b|^import /m.test(markdown),
    `plain Markdown: ${slug}`,
  );
}
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
const pages = JSON.parse(
  readFileSync(new URL('../src/generated/pages.json', import.meta.url)),
);
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
