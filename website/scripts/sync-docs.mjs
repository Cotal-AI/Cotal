// Sync the repo's canonical Markdown (/docs/*.md + /SPEC.md) into Starlight's
// content collection. The repo files stay the single source of truth; this only
// derives a frontmatter title from the first H1 and rewrites cross-links to
// Starlight routes. Generated files are git-ignored (see .gitignore).
//
// The group map below IS the site's information architecture. It moves in lockstep
// with docs/README.md (the docs index): a page added to /docs joins both in the
// same change. Missing source files fail the sync loudly — no silent drift.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, '..', 'src', 'content', 'docs');
const genDir = join(here, '..', 'src', 'generated');
const pubDir = join(here, '..', 'public');

// Where repo-relative (non-docs) links point on the web.
const GITHUB_BLOB = 'https://github.com/Cotal-AI/Cotal/blob/main';

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
      'docs/examples.md',
      'docs/connectors.md',
      'docs/connect-claude.md',
      'docs/connect-opencode.md',
      'docs/connect-codex.md',
      'docs/connect-hermes.md',
      'docs/connect-pi.md',
      'docs/build-a-client.md',
      'docs/embedding.md',
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
    files: ['docs/roadmap.md', 'docs/release.md', 'docs/stability.md', 'docs/setup-internals.md'],
  },
];

const sources = groups.flatMap((g) => g.files);

// Slugs we publish, keyed by source basename (no extension).
const knownSlugs = new Map(
  sources.map((rel) => [basename(rel).replace(/\.md$/, ''), slugFor(basename(rel).replace(/\.md$/, ''))]),
);

// Rewrite repo-relative links to site routes. Every link is first resolved
// against its source file's directory to a repo-root-relative path (sources live
// at different depths: docs/*.md vs the root SPEC.md), then mapped:
//   docs/<page>.md, SPEC.md   → the published Starlight slug (docs/README.md → /)
//   spec/cotal.schema.json    → the published /cotal.schema.json
//   assets/*                  → /assets/* (copied into public/ below)
//   anything else in the repo → GitHub
// Absolute URLs and same-page #anchors pass through. A doc link that resolves to
// an unpublished page throws — no silent drift.
// Seeded with images used by the hand-authored landing page (index.mdx), which
// doesn't pass through this rewriter.
const assetRefs = new Set(['assets/cotal-demo.webp']);

function resolveRepoPath(srcDir, target) {
  const out = srcDir ? srcDir.split('/') : [];
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) throw new Error(`link escapes the repo: ${target}`);
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

function rewriteLinks(md, srcDir) {
  return md.replace(/\]\(([^)#]+?)(#[^)]*)?\)/g, (whole, target, anchor = '') => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) return whole;
    const repoPath = resolveRepoPath(srcDir, target);
    if (repoPath === 'spec/cotal.schema.json') return `](/cotal.schema.json${anchor})`;
    if (repoPath.startsWith('assets/')) {
      assetRefs.add(repoPath);
      return `](/${repoPath}${anchor})`;
    }
    if (repoPath === 'SPEC.md' || (repoPath.startsWith('docs/') && repoPath.endsWith('.md'))) {
      const name = basename(repoPath).replace(/\.md$/, '');
      if (name === 'README') return `](/${anchor})`;
      if (!knownSlugs.has(name)) throw new Error(`link to unpublished doc: ${target}`);
      return `](/${knownSlugs.get(name)}/${anchor})`;
    }
    // Anything else in the repo (sources, examples, extension READMEs) → GitHub.
    return `](${GITHUB_BLOB}/${repoPath}${anchor})`;
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
    let md = readFileSync(src, 'utf8');
    const title = firstH1(md) ?? name;
    const description = firstParagraph(md);
    md = md.replace(/^\s*#\s+.+\n+/, ''); // drop the H1 (Starlight renders title)
    const srcDir = dirname(rel);
    md = rewriteLinks(md, srcDir === '.' ? '' : srcDir);
    const fm = [
      '---',
      `title: ${yamlEscape(title)}`,
      description ? `description: ${yamlEscape(description)}` : null,
      '---',
      '',
    ]
      .filter((l) => l !== null)
      .join('\n');
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
