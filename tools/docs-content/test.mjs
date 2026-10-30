import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { readDocument, discoverDocuments } from './index.mjs';

const metadata = '---\ntitle: Try Cotal\ndescription: Run a local mesh.\nkind: Informative\naudience: First-time users\n---\n\n';
const imports = `import { Card, Cards } from 'fumadocs-ui/components/card';
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Callout } from 'fumadocs-ui/components/callout';\n\n`;
async function fixture(t, body, ext = 'mdx') {
  const dir = await mkdtemp(join(tmpdir(), 'cotal-docs-content-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `page.${ext}`);
  await writeFile(path, ext === 'mdx' ? metadata + body : body);
  return path;
}

test('exports complete component content with native Markdown processing', async t => {
  const path = await fixture(t, imports + `<Cards>
<Card title="Install Cotal" href="installation.mdx#check-the-installation">
Keep **all** of this description.
</Card>
</Cards>

<Steps>
<Step>
## Start a mesh [#2-start-a-local-mesh]

\`\`\`bash
cotal up --detach
\`\`\`
</Step>
</Steps>

<Tabs items={['macOS', 'Linux']} defaultIndex={1}>
<Tab value="macOS">Use brew.</Tab>
<Tab value="Linux">Use apt.</Tab>
</Tabs>

<Callout type="warn" title="Stop agents">
This deletes credentials.

\`\`\`bash
cotal down --with-agents
\`\`\`
</Callout>

\`\`\`text wrap
Read https://docs.cotal.ai/prompt.md, then set up Cotal.
\`\`\`
`);
  const doc = await readDocument(path);
  assert.equal(doc.format, 'mdx');
  assert.equal(doc.metadata.kind, 'Informative');
  assert.equal(doc.metadata.audience, 'First-time users');
  assert.match(doc.content, /^import /);
  assert.match(doc.markdown, /^# Try Cotal\n/);
  for (const text of ['[Install Cotal](installation.mdx#check-the-installation)', 'Keep **all** of this description.', '## Start a mesh', 'cotal up --detach', '**macOS**', 'Use brew.', '**Linux**', 'Use apt.', 'Warning', 'Stop agents', 'This deletes credentials.', 'cotal down --with-agents', 'Read https://docs.cotal.ai/prompt.md']) assert.ok(doc.markdown.includes(text), text);
  assert.doesNotMatch(doc.markdown, /<\/?(?:Cards?|Steps?|Tabs?|Callout)\b|^import |\0/m);
  assert.doesNotMatch(doc.markdown, /> Informative/);
});

test('refuses content that cannot be exported without evaluating JavaScript', async t => {
  for (const [body, message] of [
    ['<Widget title="Lost" />', /unsupported component Widget/],
    [imports + '<Card title={compute()} href="x">Body</Card>', /static/],
    [imports + '<Card {...props}>Body</Card>', /spread/],
    ['Content {dangerous()}.', /expression/],
    ['export const value = "lost";\n\nBody.', /import/],
    ["import { Card as Banner } from 'fumadocs-ui/components/card';\n\n<Banner />", /alias/],
    ["import { Card } from './wrong-component';\n\n<Card title=\"Wrong\" href=\"x\" />", /import/],
    [imports + '<Card title="Lost" href="x" extra="Unexported" />', /attribute extra/],
    [imports + '<Tabs items={["Linux"]} groupId><Tab value="Linux">Body.</Tab></Tabs>', /groupId/],
    [imports + '<Tabs items={["Linux"]} persist="false"><Tab value="Linux">Body.</Tab></Tabs>', /persist/],
    [imports + '<Callout>\n\n# Nested title\n\nBody.\n</Callout>', /H1/],
    [imports + '<Tabs items={["macOS", "Linux"]}><Tab value="macOS">Only one.</Tab></Tabs>', /tab/i],
  ]) await assert.rejects(readDocument(await fixture(t, body)), message);
});

test('requires complete metadata and real content', async t => {
  const path = await fixture(t, 'Body.');
  await writeFile(path, '---\ntitle: Only a title\n---\n\nBody.');
  await assert.rejects(readDocument(path), /description/);
  await writeFile(path, metadata);
  await assert.rejects(readDocument(path), /empty/);
  await writeFile(path, metadata + imports);
  await assert.rejects(readDocument(path), /empty Markdown/);
  await writeFile(path, metadata + '# Duplicate title\n\nBody.');
  await assert.rejects(readDocument(path), /H1/);
});

test('keeps ordinary Markdown, including HTML and code, unchanged', async t => {
  const source = '# Existing page\n\n> Informative. For operators.\n\nA real paragraph with a [link](other.md).\n\n<details><summary>More</summary>Details</details>\n\n```sh\ncotal status\n```\n';
  const doc = await readDocument(await fixture(t, source, 'md'));
  assert.equal(doc.markdown, source);
  assert.equal(doc.metadata.title, 'Existing page');
  assert.equal(doc.metadata.description, 'A real paragraph with a link.');
  assert.doesNotMatch(doc.content, /^# /);
});

test('discovers both formats and refuses ambiguous slugs', async t => {
  const first = await fixture(t, 'Body.');
  const dir = join(first, '..');
  await writeFile(join(dir, 'other.md'), '# Other\n\nBody.');
  await writeFile(join(dir, 'README.md'), '# Index');
  assert.deepEqual((await discoverDocuments(dir)).map(p => p.split('/').at(-1)), ['other.md', 'page.mdx']);
  await writeFile(join(dir, 'page.md'), '# Duplicate\n\nBody.');
  await assert.rejects(discoverDocuments(dir), /duplicate/i);
});

test('preserves HTML-sensitive component labels as visible Markdown text', async t => {
  const title = 'Use <space> & owner';
  const doc = await readDocument(await fixture(t, imports + `<Card title="Use &lt;space&gt; &amp; owner" href="architecture.md" />

<Tabs items={['Use <space> & owner']}>
<Tab value="Use &lt;space&gt; &amp; owner">Keep the tab body.</Tab>
</Tabs>

<Callout title="Use &lt;space&gt; &amp; owner">Keep the warning.</Callout>
`));
  const tree = unified().use(remarkParse).parse(doc.markdown);
  const labels = [];
  const html = [];
  const visit = node => {
    if (node.type === 'html') html.push(node.value);
    if (node.type === 'link' || node.type === 'strong') labels.push(node.children.map(child => child.value ?? '').join(''));
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  assert.deepEqual(html, [], 'label text does not become HTML markup');
  assert.deepEqual(labels, [title, title, `Note: ${title}`]);
});
