// Sync the repo's canonical Markdown (/docs/*.md + /SPEC.md) into Starlight's
// content collection. The repo files stay the single source of truth; this only
// derives a frontmatter title from the H1 each page opens with and a description
// from the first paragraph, and rewrites cross-links to Starlight routes. Generated
// files are git-ignored (see .gitignore).
//
// The group map below IS the site's information architecture. It publishes the same
// pages docs/README.md (the docs index) links, and the sync refuses when the two
// differ. Missing source files fail the sync loudly — no silent drift.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
import { decodeString } from 'micromark-util-decode-string';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { parse as parseHtml, parseFragment } from 'parse5';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, '..', 'src', 'content', 'docs');
const genDir = join(here, '..', 'src', 'generated');
const pubDir = join(here, '..', 'public');

// Where repo-relative (non-docs) links point on the web.
const GITHUB_BLOB = 'https://github.com/Cotal-AI/Cotal/blob/main';
const blobPath = new URL(`${GITHUB_BLOB}/`).pathname;

// The Quickstart's paste-into-your-agent fence renders as the interactive
// AgentPrompt card on the site (the page is emitted as MDX; the .md twin
// endpoint restores the plain fence). The prompt's source of truth is
// src/prompt.ts; the fence in docs/getting-started.md must match it exactly.
const promptSource = readFileSync(join(here, '..', 'src', 'prompt.ts'), 'utf8');
const promptMatch = promptSource.match(/AGENT_PROMPT =\s*\n?\s*'([^']+)'/);
if (!promptMatch) throw new Error('AGENT_PROMPT not found in src/prompt.ts');
const PROMPT_FENCE = '```text wrap\n' + promptMatch[1] + '\n```';
const QUICKSTART_SRC = 'docs/getting-started.md';

// Map a source basename (no extension) to its Starlight slug. README is the docs
// index (its front-door content lives on the generated landing page), so it is
// excluded from the sync and links to it go to the site root.
const slugFor = (name) => name.toLowerCase();

// Source files in intended reading order → sidebar groups (the six-section IA).
const groups = [
  {
    label: 'Start here',
    files: ['docs/what-is-cotal.md', 'docs/getting-started.md'],
  },
  {
    // Three lanes, in order: operators → connector users → protocol implementers
    // (mirrors docs/README.md's Guides lanes).
    label: 'Guides',
    files: [
      'docs/run-a-mesh.md',
      'docs/define-a-team.md',
      'docs/watch-a-mesh.md',
      'docs/deploy.md',
      'docs/UPGRADING.md',
      'docs/examples.md',
      'docs/connectors.md',
      'docs/connect-claude.md',
      'docs/connect-opencode.md',
      'docs/connect-codex.md',
      'docs/connect-hermes.md',
      'docs/connect-jcode.md',
      'docs/connect-pi.md',
      'docs/authoring-a-connector.md',
      'docs/build-a-client.md',
      'docs/embedding.md',
    ],
  },
  {
    label: 'Concepts',
    files: [
      'docs/architecture.md',
      'docs/control-surface.md',
      'docs/workflows.md',
      'docs/spaces.md',
      'docs/transport.md',
      'docs/presence-and-delivery.md',
      'docs/identity-and-auth.md',
      'docs/delivery-daemon.md',
      'docs/security.md',
    ],
  },
  {
    label: 'Reference',
    files: [
      'docs/cli.md',
      'docs/mcp-tools.md',
      'docs/agent-files.md',
      'docs/manifest.md',
      'docs/channels-and-permissions.md',
      'docs/config.md',
      'docs/mesh-view.md',
      'docs/lang-card.md',
      'docs/glossary.md',
    ],
  },
  {
    label: 'Specification',
    files: ['SPEC.md'],
  },
  {
    label: 'Project',
    files: ['docs/roadmap.md', 'docs/release.md', 'docs/stability.md', 'docs/setup-internals.md'],
  },
];

const sources = groups.flatMap((g) => g.files);

// Slugs we publish, keyed by source path so a design note cannot take the route of a
// published page that shares its name.
const knownSlugs = new Map(sources.map((rel) => [rel, slugFor(basename(rel).replace(/\.md$/, ''))]));

// The site publishes only SPEC.md and top-level docs pages, so one of these the group map
// leaves out is drift, and every other repo file stays on GitHub.
const isSitePage = (rel) => rel === 'SPEC.md' || /^docs\/[^/]+\.md$/.test(rel);

// Rewrite repo-relative links to site routes. Every link is first resolved as a URL
// against its source file's GitHub address (sources live at different depths:
// docs/*.md vs the root SPEC.md), then its path, percent-decoded, is mapped:
//   a group-map source        → the published Starlight slug (docs/README.md → /)
//   spec/cotal.schema.json    → the published /cotal.schema.json
//   assets/*                  → /assets/* (copied into public/ below)
//   anything else in the repo → GitHub
// A query or fragment is kept. Absolute URLs and same-page #anchors pass through. A link
// to an unpublished site page or to a missing repo path throws — no silent drift.
// Seeded with images used by the hand-authored landing page (index.mdx), which
// doesn't pass through this rewriter.
const assetRefs = new Set(['assets/cotal-demo.webp']);

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
  if (knownSlugs.has(repoPath)) return `/${knownSlugs.get(repoPath)}/${suffix}`;
  if (isSitePage(repoPath)) throw new Error(`link to unpublished doc: ${target}`);
  if (!existsSync(join(repoRoot, repoPath))) throw new Error(`link to missing file: ${target}`);
  // Anything else in the repo (design notes, sources, examples, extension READMEs) → GitHub.
  return url.href;
}

// The page is parsed as the site renders it (micromark with GFM), so only real link and
// definition destinations are rewritten: code and HTML keep their text, and titled,
// angle-bracket and reference-style links are all seen. A destination is read as the site
// reads it, from the parser's text, where a NUL is already U+FFFD: its backslash escapes and
// character references are decoded and the result is percent-encoded as the renderer encodes
// it, so URL parsing neither strips whitespace nor reads a backslash as a path separator. The
// rewritten one is escaped so it parses back to the same address.
function rewriteLinks(md, rel) {
  // micromark skips one leading BOM and counts offsets from after it, so none may remain.
  md = md.replace(/^\uFEFF+/, '');
  const events = postprocess(parse({ extensions: [gfm()] }).document().write(preprocess()(md, undefined, true)));
  let out = '';
  let at = 0;
  for (const [kind, token, context] of events) {
    const { type, start, end } = token;
    if (kind !== 'enter' || (type !== 'resourceDestinationString' && type !== 'definitionDestinationString')) continue;
    const target = normalizeUri(decodeString(context.sliceSerialize(token)));
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) continue;
    out += md.slice(at, start.offset) + rewriteTarget(target, rel).replace(/[&()]/g, '\\$&');
    at = end.offset;
  }
  return out + md.slice(at);
}

// The title comes from the lexed first block, so a `#` comment in a code fence is never read as the
// H1. Starlight renders the title itself, so the H1 is dropped from the body. The lexer measures its
// spans in the text after turning CR and CRLF into LF, so the body is cut from that same text.
function splitH1(md, rel) {
  const lf = md.replace(/\r\n?/g, '\n');
  const [h1] = marked.lexer(lf);
  if (h1?.type !== 'heading' || h1.depth !== 1) throw new Error(`page does not open with an H1: ${rel}`);
  return { title: h1.text, body: lf.slice(h1.raw.length).replace(/^\n+/, '') };
}

// A hard line break renders as a br with no text, but it separates the words on either side.
const textOf = (node) =>
  node.nodeName === '#text' ? node.value : node.nodeName === 'br' ? ' ' : (node.childNodes ?? []).map(textOf).join('');

const graphemes = new Intl.Segmenter();

// Every page opens with a banner blockquote and some with headings, so the description is the
// first top-level paragraph after them that has text; an image alone has none. It is rendered and
// read back as text, so a link keeps its label and loses its target. A long one is cut where the
// character that crosses the limit begins, so the cut never splits an emoji or an accented letter.
// When the first character crosses it alone, the cut would keep nothing.
function firstParagraph(md, rel) {
  for (const token of marked.lexer(md)) {
    if (token.type !== 'paragraph') continue;
    const text = textOf(parseFragment(marked.parser([token]))).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length <= 160) return text;
    const cut = graphemes.segment(text).containing(159).index;
    if (cut === 0) throw new Error(`first character of the description is too long to cut to 160 units: ${rel}`);
    return `${text.slice(0, cut).replace(/\s+\S*$/, '')}…`;
  }
  throw new Error(`no paragraph with text to describe the page: ${rel}`);
}

function yamlEscape(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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

// Clean generated markdown (keep hand-authored .mdx like index.mdx; the
// generated getting-started.mdx is ours to remove).
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.md') || f === 'getting-started.mdx') rmSync(join(outDir, f));
}
mkdirSync(genDir, { recursive: true });

// Publish the machine-readable schema at its canonical URL (/cotal.schema.json).
mkdirSync(pubDir, { recursive: true });
copyFileSync(join(repoRoot, 'spec', 'cotal.schema.json'), join(pubDir, 'cotal.schema.json'));

// Publish the installer at /install.sh, which is what get.cotal.ai serves. The repo root
// copy is canonical and the only one to edit; this copy exists so the deployed script can
// never drift from the one people audit on GitHub.
copyFileSync(join(repoRoot, 'install.sh'), join(pubDir, 'install.sh'));

const sidebar = [];
for (const group of groups) {
  const items = [];
  for (const rel of group.files) {
    const src = join(repoRoot, rel);
    const name = basename(rel).replace(/\.md$/, '');
    const slug = slugFor(name);
    const { title, body } = splitH1(readFileSync(src, 'utf8'), rel);
    const description = firstParagraph(body, rel);
    let md = rewriteLinks(body, rel);
    const fm = ['---', `title: ${yamlEscape(title)}`, `description: ${yamlEscape(description)}`, '---', ''].join('\n');
    let ext = 'md';
    let imports = '';
    if (rel === QUICKSTART_SRC) {
      if (!md.includes(PROMPT_FENCE))
        throw new Error(`quickstart prompt fence not found: ${rel} drifted from src/prompt.ts`);
      md = md.replace(PROMPT_FENCE, '<AgentPrompt />');
      imports = "import AgentPrompt from '../../components/AgentPrompt.astro';\n\n";
      ext = 'mdx';
    }
    writeFileSync(join(outDir, `${slug}.${ext}`), fm + imports + md);
    items.push({ label: title, slug });
  }
  sidebar.push({ label: group.label, items });
}

writeFileSync(join(genDir, 'sidebar.json'), JSON.stringify(sidebar, null, 2) + '\n');

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
  `sync-docs: wrote ${sources.length} pages + sidebar.json + cotal.schema.json + ${assetRefs.size} images + ${skills.length} skills`,
);
