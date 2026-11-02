import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
import { mdxjs } from 'micromark-extension-mdxjs';
import { decodeString } from 'micromark-util-decode-string';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { parse as parseHtml, parseFragment } from 'parse5';
import { readDocument } from '@cotal-ai/docs-content';
import { connectorIcons } from '../src/lib/connector-icons.mjs';
import { httpReferences } from '../src/http-references.js';
import { publishHttpReferences } from './publish-http.mjs';
import { assertReferenceCurrent } from './http-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, '..', 'content');
const genDir = join(here, '..', 'src', 'generated');
const pubDir = join(here, '..', 'public');

// Where repo-relative (non-docs) links point on the web.
const GITHUB_BLOB = 'https://github.com/Cotal-AI/Cotal/blob/main';
const blobPath = new URL(`${GITHUB_BLOB}/`).pathname;

// Map a source basename (no extension) to its Fumadocs slug. README is the docs
// index (its front-door content lives on the generated landing page), so it is
// excluded from the sync and links to it go to the site root.
const slugFor = (name) => name.toLowerCase();

const page = (source) => ({ kind: 'page', source });
const group = (title, children) => ({ kind: 'group', title, children });
const navigation = [
  { section: 'docs', title: 'Docs', children: [
    group('Start here', ['what-is-cotal', 'installation', 'getting-started', 'using-cotal', 'examples'].map(name => page(`docs/${name}.mdx`))),
    group('Guides', [
      group('Operate a mesh', [
        page('docs/setup.mdx'),
        page('docs/run-a-mesh.mdx'),
        page('docs/launch-agents.mdx'),
        page('docs/define-a-team.mdx'),
        page('docs/register-a-mesh.mdx'),
        page('docs/watch-a-mesh.mdx'),
        page('docs/telemetry.mdx'),
        page('docs/console.mdx'),
        page('docs/web-dashboard.mdx'),
        page('docs/remote-supervision.mdx'),
        page('docs/supervise-processes.mdx'),
        page('docs/deploy.mdx'),
        page('docs/backup-a-mesh.mdx'),
        page('docs/recover-a-mesh.mdx'),
        page('docs/upgrade-cotal.mdx'),
      ]),
      group('Connect agents', ['connectors', 'connect-claude', 'connect-opencode', 'connect-codex', 'connect-hermes', 'connect-jcode', 'connect-pi'].map(name => page(`docs/${name}.mdx`))),
      group('Build integrations', [
        ...['authoring-a-connector', 'build-a-client', 'embedding'].map(name => page(`docs/${name}.mdx`)),
        group('Embedding reference', ['exports', 'endpoints', 'remote-clients', 'daemons', 'provisioning', 'schema-inspection', 'service-authority', 'service-custody', 'service-host', 'service-access', 'service-callers', 'manager', 'delegated-seats'].map(name => page(`docs/embedding-${name}.mdx`))),
        group('Connector reference', [
          page('docs/connector-runtime-reference.mdx'),
          ...['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi'].map(name => page(`docs/${name}-connector-reference.mdx`)),
        ]),
      ]),
    ]),
    group('Concepts', [
      group('Fundamentals', ['architecture', 'spaces', 'transport'].map(name => page(`docs/${name}.mdx`))),
      group('Messaging', [
        ...['presence-and-delivery', 'delivery-daemon'].map(name => page(`docs/${name}.mdx`)),
        group('Reference', [page('docs/delivery-service-reference.mdx')]),
      ]),
      group('Security', [
        ...['identity-and-auth', 'security'].map(name => page(`docs/${name}.mdx`)),
        group('Reference', ['identity-authority', 'identity-user-auth', 'identity-service-auth', 'security-boundaries'].map(name => page(`docs/${name}.mdx`))),
      ]),
      group('Agent coordination', [
        ...['control-surface', 'workflows'].map(name => page(`docs/${name}.mdx`)),
        group('Reference', ['control-discovery', 'control-lifecycle', 'workflow-operations', 'workflow-runtime', 'workflow-effects'].map(name => page(`docs/${name}.mdx`))),
      ]),
    ]),
    group('Specification', [page('SPEC.md')]),
    group('Project', ['roadmap', 'release', 'stability', 'setup-internals', 'UPGRADING'].map(name => page(`docs/${name}.md`))),
  ] },
  { section: 'api-reference', title: 'API Reference', children: [
    page('docs/overview.mdx'),
    page('docs/api-reference.mdx'),
    group('CLI', [
      page('docs/cli.mdx'),
      group('Workstation', ['cli-usage', 'cli-installation', 'cli-selection'].map(name => page(`docs/${name}.mdx`))),
      group('Mesh lifecycle', ['cli-startup', 'cli-shutdown', 'cli-backups'].map(name => page(`docs/${name}.mdx`))),
      group('Agents', ['cli-agents', 'cli-agent-control', 'cli-agent-views'].map(name => page(`docs/${name}.mdx`))),
      group('Services', ['cli-services', 'cli-processes', 'cli-maintenance', 'cli-integrations'].map(name => page(`docs/${name}.mdx`))),
      group('Communication', ['cli-endpoints', 'cli-messaging', 'cli-observation'].map(name => page(`docs/${name}.mdx`))),
      page('docs/cli-auth.mdx'),
      page('docs/cli-runs.mdx'),
    ]),
    group('Agent tools', [page('docs/mcp-tools.mdx'), page('docs/agent-briefing.mdx')]),
    group('Configuration', ['agent-files', 'manifest', 'channels-and-permissions', 'config'].map(name => page(`docs/${name}.mdx`))),
    group('Models', ['mesh-view', 'lang-card', 'glossary'].map(name => page(`docs/${name}.mdx`))),
  ] },
];
const publications = [];
const collectPages = (children, section) => {
  for (const node of children) {
    if (node.kind === 'group') collectPages(node.children, section);
    else publications.push({ source: node.source, section });
  }
};
for (const section of navigation) collectPages(section.children, section.section);
const referenceSources = new Set(httpReferences.map(reference => reference.docSource));
const sources = [...publications.map(page => page.source), ...referenceSources];
const sectionBySource = new Map(publications.map(page => [page.source, page.section]));
if (sectionBySource.size !== publications.length) throw new Error('page appears more than once in navigation');
const sectionFor = rel => {
  const section = sectionBySource.get(rel);
  if (!section) throw new Error(`page is absent from navigation: ${rel}`);
  return section;
};
const knownSlugs = new Map(publications.map(({ source: rel }) => [rel, `${sectionFor(rel)}/${slugFor(basename(rel).replace(/\.mdx?$/, ''))}`]));
for (const reference of httpReferences) knownSlugs.set(reference.docSource, reference.base);
if (new Set(knownSlugs.values()).size !== sources.length) throw new Error('duplicate published page URL');
const fragmentLinks = [];

// The site publishes only SPEC.md and top-level docs pages, so one of these the group map
// leaves out is drift, and every other repo file stays on GitHub.
const isSitePage = (rel) => rel === 'SPEC.md' || /^docs\/[^/]+\.mdx?$/.test(rel);

// Rewrite repo-relative links to site routes. Every link is first resolved as a URL
// against its source file's GitHub address (sources live at different depths:
// docs/*.md vs the root SPEC.md), then its path, percent-decoded, is mapped:
//   a group-map source        → the published Fumadocs slug (docs/README.md → /)
//   spec/cotal.schema.json    → the published /cotal.schema.json
//   assets/*                  → /assets/* (copied into public/ below)
//   anything else in the repo → GitHub
// A query or fragment is kept. Absolute URLs and same-page #anchors pass through. A link
// to an unpublished site page or to a missing repo path throws — no silent drift.
// Seeded with images used by the hand-authored landing page (index.mdx), which
// doesn't pass through this rewriter.
const assetRefs = new Set(['assets/cotal-demo.webp', ...[...connectorIcons.values()].map(src => src.slice(1))]);

function rewriteTarget(target, rel) {
  const url = new URL(target, `${GITHUB_BLOB}/${rel}`);
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith(blobPath)) throw new Error(`link escapes the repo: ${target}`);
  const repoPath = path.slice(blobPath.length);
  // Taken from the destination itself: URL getters drop an empty `?` or `#`.
  const suffix = target.slice(target.search(/[?#]|$/));
  if (repoPath === 'spec/cotal.schema.json') return `/cotal.schema.json${suffix}`;
  if (repoPath.startsWith('assets/')) {
    assetRefs.add(repoPath);
    return url.href.slice(GITHUB_BLOB.length);
  }
  if (repoPath === 'docs/README.md') return `/${suffix}`;
  if (knownSlugs.has(repoPath)) {
    if (url.hash) fragmentLinks.push([rel, repoPath, url.hash]);
    return `/${knownSlugs.get(repoPath)}/${suffix}`;
  }
  if (isSitePage(repoPath)) throw new Error(`link to unpublished doc: ${target}`);
  if (!existsSync(join(repoRoot, repoPath))) throw new Error(`link to missing file: ${target}`);
  // Anything else in the repo (design notes, sources, examples, extension READMEs) → GitHub.
  return url.href;
}

// Absolute URLs, site-root paths and same-page anchors already resolve on the site.
const isRepoRelative = (target) =>
  !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('/') && !target.startsWith('#');

// The attributes through which an HTML or JSX tag names a URL. A srcset lists candidates, each a
// URL (a run of non-whitespace, less the commas that end it) and descriptors up to the next comma.
const URL_ATTRS = new Set(['href', 'src', 'srcset']);
const SRCSET_CANDIDATE = /([\t\n\f\r ,]*)([^\t\n\f\r ]+)(?<!,)([^,]*)/g;

// The URL parser's first steps: it drops leading and trailing C0 controls and spaces and every
// tab and newline, so a value is classified by the URL the browser resolves.
const urlInput = (value) => value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');

function rewriteAttr(name, value, rel) {
  const rewrite = (url) => {
    const target = urlInput(url);
    if (name === 'href' && target.startsWith('#')) fragmentLinks.push([rel, rel, target]);
    return isRepoRelative(target) ? rewriteTarget(target, rel) : url;
  };
  if (name !== 'srcset') return rewrite(value);
  return value.replace(SRCSET_CANDIDATE, (_, lead, url, descriptors) => lead + rewrite(url) + descriptors);
}

// Character references for the markup characters, so the value parses back the same inside either quote.
const escapeAttr = (value) => value.replace(/[&"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Raw HTML is parsed as the browser parses it, so a URL attribute is read decoded, as the browser
// resolves it. One that changes is written back whole and double-quoted.
function* htmlEdits(node, offset, rel) {
  for (const { prefix, name, value } of node.attrs ?? []) {
    const next = URL_ATTRS.has(name) ? rewriteAttr(name, value, rel) : value;
    if (next === value) continue;
    const source = prefix ? `${prefix}:${name}` : name;
    const { startOffset, endOffset } = node.sourceCodeLocation.attrs[source];
    yield [offset + startOffset, offset + endOffset, `${source}="${escapeAttr(next)}"`];
  }
  // A template holds its children in a separate content fragment, which the page ships too.
  for (const child of (node.content ?? node).childNodes ?? []) yield* htmlEdits(child, offset, rel);
}

// The page is parsed as the site renders it (micromark with the page's syntax extensions), so
// only real link and definition destinations and the URL attributes of HTML and JSX tags are
// rewritten: code and MDX JavaScript keep their text, and titled, angle-bracket and
// reference-style links are all seen. A destination is read as the site reads it, from the
// parser's text, where a NUL is already U+FFFD: its backslash escapes and character references
// are decoded and the result is percent-encoded as the renderer encodes it, so URL parsing
// neither strips whitespace nor reads a backslash as a path separator. The rewritten one is
// escaped so it parses back to the same address.
function rewriteLinks(md, rel, extensions) {
  // micromark skips one leading BOM and counts offsets from after it, so none may remain.
  md = md.replace(/^\uFEFF+/, '');
  const events = postprocess(parse({ extensions }).document().write(preprocess()(md, undefined, true)));
  // A blockquote opens each line of the HTML in it with a `>` the browser never sees.
  const html = md.split('');
  for (const [kind, { type, start, end }] of events)
    if (kind === 'enter' && type === 'blockQuotePrefix') html.fill(' ', start.offset, end.offset);
  // Keyed by where each starts: parse5 rebuilds a misnested formatting element as a copy that
  // carries the same source attributes, and a source attribute is rewritten once.
  const edits = new Map();
  let attr;
  for (const [kind, token, context] of events) {
    const { type, start, end } = token;
    if (kind !== 'enter') continue;
    if (type === 'resourceDestinationString' || type === 'definitionDestinationString') {
      const target = normalizeUri(decodeString(context.sliceSerialize(token)));
      if (target.startsWith('#')) fragmentLinks.push([rel, rel, target]);
      if (!isRepoRelative(target)) continue;
      edits.set(start.offset, [end.offset, rewriteTarget(target, rel).replace(/[&()]/g, '\\$&')]);
    } else if (type === 'htmlFlow' || type === 'htmlText') {
      const fragment = parseFragment(html.slice(start.offset, end.offset).join(''), { sourceCodeLocationInfo: true });
      for (const [from, to, text] of htmlEdits(fragment, start.offset, rel)) edits.set(from, [to, text]);
    } else if (type === 'mdxJsxFlowTagAttributeNamePrimary' || type === 'mdxJsxTextTagAttributeNamePrimary') {
      attr = context.sliceSerialize(token).toLowerCase();
    } else if (type === 'mdxJsxFlowTagAttributeValueLiteralValue' || type === 'mdxJsxTextTagAttributeValueLiteralValue') {
      // JSX decodes character references but has no backslash escapes, so no backslash may start one.
      const value = decodeString(context.sliceSerialize(token).replace(/\\/g, '\\\\'));
      const next = URL_ATTRS.has(attr) ? rewriteAttr(attr, value, rel) : value;
      if (next !== value) edits.set(start.offset, [end.offset, escapeAttr(next)]);
    }
  }
  let out = '';
  let at = 0;
  for (const [from, [to, text]] of [...edits].sort(([a], [b]) => a - b)) {
    out += md.slice(at, from) + text;
    at = to;
  }
  return out + md.slice(at);
}

// The index also links design notes (docs/design/) and spec/ references, which stay on
// GitHub, so only its links to SPEC.md and top-level docs pages must match the group map.
// Readers follow the links of the rendered index on GitHub, and a hand-written reading of
// its Markdown or HTML misses spellings a browser follows, so the index is rendered, parsed
// as HTML, and each link resolved as a URL against the index's GitHub address. GitHub serves
// a percent-encoded path as the same file, so paths are compared decoded. A link back to the
// index itself, such as one to a heading, names no page.
const indexUrl = new URL(`${GITHUB_BLOB}/docs/README.md`);
const indexed = new Set();
const visit = (node) => {
  node.childNodes?.forEach(visit);
  const href = (node.nodeName === 'a' || node.nodeName === 'area') && node.attrs.find((attr) => attr.name === 'href');
  if (!href) return;
  const url = new URL(href.value, indexUrl);
  if (url.origin !== indexUrl.origin) return;
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith(blobPath) || path === indexUrl.pathname) return;
  const rel = path.slice(blobPath.length);
  if (isSitePage(rel)) indexed.add(rel);
};
visit(parseHtml(marked.parse(readFileSync(join(repoRoot, 'docs', 'README.md'), 'utf8'))));
for (const rel of indexed) if (!sources.includes(rel)) throw new Error(`indexed but not in the group map: ${rel}`);
for (const rel of sources) if (!indexed.has(rel)) throw new Error(`in the group map but not indexed: ${rel}`);

for (const reference of httpReferences) assertReferenceCurrent(reference);

const documents = new Map(await Promise.all(sources.map(async rel =>
  [rel, await readDocument(join(repoRoot, rel))],
)));

mkdirSync(outDir, { recursive: true });
for (const section of ['docs', 'api-reference', 'api']) rmSync(join(outDir, section), { recursive: true, force: true });
mkdirSync(genDir, { recursive: true });

// Publish the machine-readable schema at its canonical URL (/cotal.schema.json).
mkdirSync(pubDir, { recursive: true });
copyFileSync(join(repoRoot, 'spec', 'cotal.schema.json'), join(pubDir, 'cotal.schema.json'));

// Publish the installer at /install.sh, which is what get.cotal.ai serves. The repo root
// copy is canonical and the only one to edit; this copy exists so the deployed script can
// never drift from the one people audit on GitHub.
copyFileSync(join(repoRoot, 'install.sh'), join(pubDir, 'install.sh'));

for (const [rel, document] of documents) {
  if (referenceSources.has(rel)) continue;
  const slug = slugFor(basename(rel).replace(/\.mdx?$/, ''));
  const extensions = document.format === 'mdx' ? [mdxjs(), gfm()] : [gfm()];
  const body = rewriteLinks(document.content, rel, extensions);
  const metadata = { ...document.metadata, ...(connectorIcons.has(slug) ? { icon: slug } : {}) };
  const frontmatter = ['---', ...Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', ''].join('\n');
  const section = sectionFor(rel);
  mkdirSync(join(outDir, section), { recursive: true });
  writeFileSync(join(outDir, section, `${slug}.${document.format}`), frontmatter + body);
}

// Copy every image the pages reference into public/. copyFileSync throws on a
// missing source, so a dead image link fails the sync instead of 404ing live.
for (const rel of assetRefs) {
  const dest = join(pubDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(repoRoot, rel), dest);
}

// Publish the Agent Skills discovery index (/.well-known/agent-skills/index.json,
// Agent Skills Discovery RFC v0.2.0): one entry per committed SKILL.md, digested
// here so the hash can never drift from the artifact. public/ is copied into
// dist verbatim, so the source digest is the served digest.
const skillsDir = join(pubDir, '.well-known', 'agent-skills');

// Cotal's authored skills have ONE source of truth: implementations/cli/cotal-skills/skills (the same
// files ship in the CLI package for the Claude Code plugin and drop into ~/.agents/skills). Generate
// the served copies from it so there is no committed twin to drift. This discovery index is a forward
// bet (the Cloudflare .well-known/agent-skills RFC is still Draft and no shipping harness consumes it
// yet), which is why the working cross-vendor path is the .agents/skills drop, not this.
const canonicalSkillsDir = join(repoRoot, 'implementations', 'cli', 'cotal-skills', 'skills');
const canonicalSkillNames = new Set(
  readdirSync(canonicalSkillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
);
// Skills authored directly here (no canonical twin) that must never be treated as generated/removable.
const committedSkills = new Set(['cotal-setup']);
// Reconcile FIRST (central removal): drop any previously-generated skill dir that is no longer canonical,
// so a removed/renamed Cotal skill stops being served and re-indexed. Never touch committed skills.
for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || committedSkills.has(entry.name) || canonicalSkillNames.has(entry.name)) continue;
  rmSync(join(skillsDir, entry.name), { recursive: true, force: true });
}
// Then generate the current canonical set. copyFileSync throws on a missing canonical SKILL.md, failing
// the sync loudly.
for (const name of canonicalSkillNames) {
  const dest = join(skillsDir, name, 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(canonicalSkillsDir, name, 'SKILL.md'), dest);
}

const skills = [];
for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(skillsDir, entry.name, 'SKILL.md'); // missing SKILL.md fails the sync
  const raw = readFileSync(file);
  const description = raw.toString('utf8').match(/^description:\s*"?(.+?)"?\s*$/m)?.[1];
  if (!description) throw new Error(`no description frontmatter in ${file}`);
  skills.push({
    name: entry.name,
    type: 'skill-md',
    description,
    url: `/.well-known/agent-skills/${entry.name}/SKILL.md`,
    digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
  });
}
writeFileSync(
  join(skillsDir, 'index.json'),
  JSON.stringify(
    { $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', skills },
    null,
    2,
  ) + '\n',
);

console.log(
  `sync-docs: wrote ${sources.length} pages + cotal.schema.json + ${assetRefs.size} images + ${skills.length} skills`,
);


const textOf = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(textOf).join('');
function anchorsOf(document) {
  const label = text => textOf(parseFragment(marked.parseInline(text))).replace(/\s+/g, ' ').trim();
  const explicit = new Map();
  let fence;
  for (const line of document.content.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^#{2,6}\s+(.+?)\s+\[#([^\]]+)\]\s*$/.exec(line);
    if (!heading) continue;
    const key = label(heading[1]);
    const ids = explicit.get(key) ?? [];
    ids.push(heading[2]);
    explicit.set(key, ids);
  }
  const ids = new Set();
  const seen = new Map();
  const walk = tokens => {
    for (const token of tokens ?? []) {
      if (token.type === 'heading' && token.depth !== 1) {
        const text = label(token.text.replace(/\s+\[#[^\]]+\]\s*$/, ""));
        const native = explicit.get(text)?.shift();
        if (native) ids.add(native);
        else {
          const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          ids.add(n ? `${base}-${n}` : base);
        }
      }
      walk(token.tokens);
      walk(token.items);
    }
  };
  walk(marked.lexer(document.markdown));
  for (const [, id] of document.content.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) ids.add(id);
  return ids;
}
const anchors = new Map([...documents].map(([rel, document]) => [rel, anchorsOf(document)]));

// The manifest drives static exports, navigation and legacy redirects.
for (const section of ['docs', 'api-reference', 'api']) {
  rmSync(join(pubDir, section), { recursive: true, force: true });
}
const http = publishHttpReferences({
  outDir, pubDir, genDir, documents,
  rewriteMarkdown: (markdown, rel) => rewriteLinks(markdown, rel, [gfm()]),
});
const pages = [...documents].filter(([rel]) => !referenceSources.has(rel)).map(([rel, document]) => {
  const slug = slugFor(basename(rel).replace(/\.mdx?$/, ''));
  return { slug, title: document.metadata.title, section: sectionFor(rel), url: `/${sectionFor(rel)}/${slug}/`,
    markdown: rewriteLinks(document.markdown, rel, [gfm()]) };
});
pages.push(...http.pages);
const agents = await readDocument(join(here, '../src/content/docs/docs-for-agents.mdx'));
const routeAgentLinks = text => text.replace(/\/([a-z-]+)(\/|\.md)/g, (match, slug, end) => {
  const page = pages.find(p => p.slug === slug);
  return page ? page.url.slice(0, -1) + end : match;
});
const agentsFrontmatter = ['---', ...Object.entries(agents.metadata)
  .map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', ''].join('\n');
writeFileSync(join(outDir, 'docs/docs-for-agents.mdx'), agentsFrontmatter + routeAgentLinks(agents.content));
pages.push({ slug: 'docs-for-agents', title: agents.metadata.title, section: 'docs', url: '/docs/docs-for-agents/', markdown: routeAgentLinks(agents.markdown) });
const publishedNavigation = navigation.map(section => {
  const convert = node => node.kind === 'page'
    ? { kind: 'page', url: `/${knownSlugs.get(node.source)}/` }
    : { kind: 'group', title: node.title, children: node.children.map(convert) };
  const children = section.children.map(convert);
  if (section.section === 'api-reference') children.push(...http.navigation);
  if (section.section === 'docs') children.push({ kind: 'group', title: 'For agents', children: [{ kind: 'page', url: '/docs/docs-for-agents/' }] });
  const order = pages.filter(page => page.section === section.section).map(page => page.slug);
  writeFileSync(join(outDir, section.section, 'meta.json'), JSON.stringify({ title: section.title, root: true, pages: order }, null, 2));
  return { section: section.section, title: section.title, children };
});
writeFileSync(join(genDir, 'navigation.mjs'), `// @ts-check\n/** @type {import('../lib/navigation').NavigationSection[]} */\nexport const navigation = ${JSON.stringify(publishedNavigation, null, 2)};\n`);
writeFileSync(join(genDir, 'pages.json'), JSON.stringify(pages, null, 2));
writeFileSync(join(genDir, 'routes.json'), JSON.stringify(pages.map(({slug,url}) => ({slug,url}))));
const redirects = ['/ /docs/what-is-cotal/ 301', '/docs /docs/what-is-cotal/ 301', '/docs/ /docs/what-is-cotal/ 301', '/api-reference /api-reference/api-reference/ 301', '/api-reference/ /api-reference/api-reference/ 301', '/agent-frameworks /docs/connect-pi/ 301', '/agent-frameworks/ /docs/connect-pi/ 301', '/agent-frameworks.md /docs/connect-pi.md 301'];
for (const page of pages.filter(page => page.section !== 'api' && page.slug !== 'api-reference')) redirects.push(`/${page.slug} ${page.url} 301`, `/${page.slug}/ ${page.url} 301`, `/${page.slug}.md ${page.url.slice(0, -1)}.md 301`);
redirects.push('/api-reference.md /api-reference/api-reference.md 301');
for (const reference of httpReferences) redirects.push(`/${reference.docSlug} /${reference.base}/ 301`, `/${reference.docSlug}/ /${reference.base}/ 301`);
writeFileSync(join(pubDir, '_redirects'), redirects.join('\n') + '\n');
for (const page of pages) {
  const file = join(pubDir, page.url.slice(1, -1) + '.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page.markdown);
}
const origin = 'https://docs.cotal.ai';
const taskRoutes = [
  ['getting-started', 'Install Cotal, start a local mesh, and launch your first agent.'],
  ['using-cotal', 'Choose between personal sessions, hosted spaces, teams, and service integrations.'],
  ['mcp-tools', 'Message peers, inspect the mesh, and manage teammates from an agent session.'],
  ['define-a-team', 'Declare agents and channels in a team manifest.'],
  ['channels-and-permissions', 'Grant or audit channel subscriptions and publishing permissions.'],
  ['agent-files', 'Define a persona and its launch configuration.'],
  ['watch-a-mesh', 'Observe activity through the console, event stream, or browser dashboard.'],
  ['identity-and-auth', 'Understand credentials, authentication, and issued authority.'],
  ['workflows', 'Coordinate durable work, human checkpoints, and recovery.'],
  ['build-a-client', 'Implement a client for the wire contract.'],
  ['spec', 'Check the normative protocol requirements.'],
].map(([slug, description]) => {
  const page = pages.find(page => page.slug === slug);
  if (!page) throw new Error(`task route names an unpublished page: ${slug}`);
  return `- [${page.title}](${origin}${page.url.slice(0, -1)}.md): ${description}`;
});
const taskRouting = '## Route by task\n\n' +
  '- [Agent setup prompt](https://docs.cotal.ai/prompt.md): Run the setup instructions with your coding agent.\n' +
  taskRoutes.join('\n') + '\n\n## All pages\n\n';
writeFileSync(join(pubDir, 'llms.txt'), '# Cotal\n\nA standard wire interface for agents over NATS + JetStream. The normative wire specification wins where other pages disagree. Roadmap content is not shipped behavior.\n\n- [All documentation](https://docs.cotal.ai/llms-full.txt)\n- [Compact documentation](https://docs.cotal.ai/llms-small.txt)\n- [Agent setup prompt](https://docs.cotal.ai/prompt.md)\n- [Message schema](https://docs.cotal.ai/cotal.schema.json)\n\n' + httpReferences.map(reference => `- [${reference.label} OpenAPI](${origin}/${reference.specFile})`).join('\n') + '\n\n' + taskRouting + pages.map(p => `- [${p.title}](${origin}${p.url.slice(0, -1)}.md)`).join('\n') + '\n');
for (const [name, subset] of [['full', pages], ['small', pages.filter(p => !['release', 'setup-internals', 'roadmap'].includes(p.slug))]]) {
  writeFileSync(join(pubDir, `llms-${name}.txt`), subset.map(p => `Source: ${origin}${p.url}\n\n${p.markdown}`).join('\n\n'));
}
writeFileSync(join(pubDir, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + pages.map(p => `<url><loc>${origin}${p.url}</loc></url>`).join('') + '</urlset>');
writeFileSync(join(pubDir, 'sitemap-index.xml'), '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://docs.cotal.ai/sitemap.xml</loc></sitemap></sitemapindex>');

const missingFragments = fragmentLinks.filter(([, target, hash]) => !anchors.get(target)?.has(decodeURIComponent(hash.slice(1))));
if (missingFragments.length) throw new Error(`link to a missing anchor:\n${missingFragments.map(([from, target, hash]) => `  ${from}: ${target === from ? '' : target}${hash}`).join('\n')}`);
