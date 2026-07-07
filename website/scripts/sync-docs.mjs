// Sync the repo's canonical Markdown (/docs/*.md + /SPEC.md) into Starlight's
// content collection. The repo files stay the single source of truth; this only
// derives a frontmatter title from the first H1 and rewrites cross-links to
// Starlight routes. Generated files are git-ignored (see .gitignore).
//
// The group map below IS the site's information architecture. It moves in lockstep
// with docs/README.md (the docs index): a page added to /docs joins both in the
// same change. Missing source files fail the sync loudly — no silent drift.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, '..', 'src', 'content', 'docs');
const genDir = join(here, '..', 'src', 'generated');
const pubDir = join(here, '..', 'public');

// Where repo-relative (non-docs) links point on the web.
const GITHUB_BLOB = 'https://github.com/Cotal-AI/Cotal/blob/main';

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
      'docs/examples.md',
      'docs/connect-claude.md',
      'docs/connect-opencode.md',
      'docs/connect-hermes.md',
      'docs/build-a-client.md',
    ],
  },
  {
    label: 'Concepts',
    files: [
      'docs/architecture.md',
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
      'docs/glossary.md',
    ],
  },
  {
    label: 'Specification',
    files: ['SPEC.md'],
  },
  {
    label: 'Project',
    files: ['docs/roadmap.md', 'docs/release.md', 'docs/setup-internals.md'],
  },
];

const sources = groups.flatMap((g) => g.files);

// Slugs we publish, keyed by source basename (no extension).
const knownSlugs = new Map(
  sources.map((rel) => [basename(rel).replace(/\.md$/, ''), slugFor(basename(rel).replace(/\.md$/, ''))]),
);

// Rewrite cross-links to site routes. Four cases, everything else untouched:
//  1. same-dir doc links (`getting-started.md`, `../SPEC.md`, `README.md`) → /slug/
//  2. the generated schema (`../spec/cotal.schema.json`) → the published /cotal.schema.json
//  3. repo images (`../assets/...`) → /assets/... (copied into public/ below)
//  4. other repo-relative links (`../packages/...`, `../examples/...`) → GitHub
// Seeded with images used by the hand-authored landing page (index.mdx), which
// doesn't pass through this rewriter.
const assetRefs = new Set(['assets/cotal-demo.webp']);
function rewriteLinks(md) {
  // Case 2 first (not a .md link).
  md = md.replaceAll('](../spec/cotal.schema.json)', '](/cotal.schema.json)');
  // Cases 1 + 3 + 4.
  return md.replace(/\]\(([^)#]+?)(#[^)]*)?\)/g, (whole, target, anchor = '') => {
    if (/^[a-z]+:\/\//.test(target) || target.startsWith('/') || target.startsWith('#')) return whole;
    if (target.startsWith('../assets/')) {
      const rel = target.slice(3); // assets/foo.webp
      assetRefs.add(rel);
      return `](/${rel})`;
    }
    const isDocLink =
      (target.endsWith('.md') && !target.includes('/')) || target === '../SPEC.md' || target === 'README.md';
    if (isDocLink) {
      const name = basename(target).replace(/\.md$/, '');
      if (name === 'README') return `](/${anchor})`;
      if (!knownSlugs.has(name)) throw new Error(`link to unpublished doc: ${target}`);
      const slug = knownSlugs.get(name);
      return `](/${slug}/${anchor})`;
    }
    // Repo-relative source/example link → GitHub.
    if (target.startsWith('../')) return `](${GITHUB_BLOB}/${target.replace(/^(\.\.\/)+/, '')}${anchor})`;
    return whole;
  });
}

function firstH1(md) {
  const m = md.match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function firstParagraph(md) {
  const body = md.replace(/^\s*#\s+.+\n+/, '');
  const m = body.match(/^(?!\s*[#>\-*`|!])\s*(\S.+?)(?:\n\s*\n|$)/s);
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

// Publish the machine-readable schema at its canonical URL (/cotal.schema.json).
mkdirSync(pubDir, { recursive: true });
copyFileSync(join(repoRoot, 'spec', 'cotal.schema.json'), join(pubDir, 'cotal.schema.json'));

const sidebar = [];
for (const group of groups) {
  const items = [];
  for (const rel of group.files) {
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

// Copy every image the pages reference into public/. copyFileSync throws on a
// missing source, so a dead image link fails the sync instead of 404ing live.
for (const rel of assetRefs) {
  const dest = join(pubDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(repoRoot, rel), dest);
}

console.log(
  `sync-docs: wrote ${sources.length} pages + sidebar.json + cotal.schema.json + ${assetRefs.size} images`,
);
