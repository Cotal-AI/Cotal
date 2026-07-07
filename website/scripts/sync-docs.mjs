// Sync the repo's canonical Markdown (/docs/*.md + /SPEC.md) into Starlight's
// content collection. The repo files stay the single source of truth; this only
// derives a frontmatter title from the first H1 and rewrites *.md cross-links to
// Starlight routes. Generated files are git-ignored (see .gitignore).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, '..', 'src', 'content', 'docs');
const genDir = join(here, '..', 'src', 'generated');

// Map a source basename (no extension) to its Starlight slug. README is the docs
// index (replaced by the generated landing page), so it is excluded entirely.
const slugFor = (name) => name.toLowerCase();

// Source files in intended reading order → sidebar groups.
const groups = [
  {
    label: 'Start here',
    files: [['docs/getting-started.md'], ['docs/OVERVIEW.md']],
  },
  {
    label: 'Protocol',
    files: [
      ['docs/architecture.md'],
      ['docs/protocol-view.md'],
      ['docs/spaces.md'],
      ['docs/transport.md'],
      ['docs/security.md'],
      ['docs/manifest.md'],
      ['docs/web.md'],
      ['SPEC.md'],
    ],
  },
  {
    label: 'Integrate',
    files: [['docs/claude-code-integration.md'], ['docs/examples.md']],
  },
  {
    label: 'Operate',
    files: [['docs/release.md'], ['docs/setup-internals.md']],
  },
];

const sources = groups.flatMap((g) => g.files.map(([p]) => p));

// All known slugs, so cross-link rewriting only touches links we actually publish.
const knownSlugs = new Map(
  sources.map((rel) => [basename(rel).replace(/\.md$/, ''), slugFor(basename(rel).replace(/\.md$/, ''))]),
);
knownSlugs.set('README', ''); // -> site root

// Rewrite `](…/Name.md#anchor)` to `](/slug/#anchor)` for files we publish.
function rewriteLinks(md) {
  return md.replace(/\]\(([^)]+?\.md)(#[^)]*)?\)/g, (whole, target, anchor = '') => {
    const name = basename(target).replace(/\.md$/, '');
    if (!knownSlugs.has(name)) return whole; // leave external/unknown links untouched
    const slug = knownSlugs.get(name);
    return `](/${slug}${slug ? '/' : ''}${anchor})`;
  });
}

function firstH1(md) {
  const m = md.match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function firstParagraph(md) {
  const body = md.replace(/^\s*#\s+.+\n+/, '');
  const m = body.match(/^(?!\s*[#>\-*`|])\s*(\S.+?)(?:\n\s*\n|$)/s);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').replace(/[*_`[\]]/g, '').slice(0, 160).trim();
}

function yamlEscape(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Clean generated markdown (keep hand-authored .mdx like index.mdx).
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.md')) rmSync(join(outDir, f));
}
mkdirSync(genDir, { recursive: true });

const sidebar = [];
for (const group of groups) {
  const items = [];
  for (const [rel] of group.files) {
    const src = join(repoRoot, rel);
    const name = basename(rel).replace(/\.md$/, '');
    const slug = slugFor(name);
    let md = readFileSync(src, 'utf8');
    const title = firstH1(md) ?? name;
    const description = firstParagraph(md);
    md = md.replace(/^\s*#\s+.+\n+/, ''); // drop the H1 (Starlight renders title)
    md = rewriteLinks(md);
    const fm = [
      '---',
      `title: ${yamlEscape(title)}`,
      description ? `description: ${yamlEscape(description)}` : null,
      '---',
      '',
    ]
      .filter((l) => l !== null)
      .join('\n');
    writeFileSync(join(outDir, `${slug}.md`), fm + md);
    items.push({ label: title, slug });
  }
  sidebar.push({ label: group.label, items });
}

writeFileSync(join(genDir, 'sidebar.json'), JSON.stringify(sidebar, null, 2) + '\n');

console.log(`sync-docs: wrote ${sources.length} pages + sidebar.json`);
