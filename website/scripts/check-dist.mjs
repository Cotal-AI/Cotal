// Post-build sanity checks — fail the build when a generated artifact regresses.
//  1. llms.txt must keep its task-router links (an unlinked llms.txt routes nothing).
//  2. No published page, Markdown twin, or llms set may ship a repo-relative link
//     that only resolves on GitHub (they render 404 on the site).
//  3. The agent-readiness surface (robots.txt, the agent-skills index) must keep
//     its directives, and every skill digest must match the artifact it points at.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const fail = (msg) => {
  console.error(`check-dist: ${msg}`);
  process.exit(1);
};

const llms = readFileSync(join(dist, 'llms.txt'), 'utf8');
for (const needle of ['/prompt.md', '/getting-started.md', '/mcp-tools.md', '/spec.md', '/cotal.schema.json']) {
  if (!llms.includes(needle)) fail(`llms.txt lost its task link to ${needle}`);
}

// The agent setup runbook must ship, keep its commands, and stay in step with
// the Quickstart (same commands, so neither can drift alone).
const runbook = readFileSync(join(dist, 'prompt.md'), 'utf8');
for (const cmd of ['npx cotal-ai setup --yes', 'npx cotal-ai up --detach']) {
  if (!runbook.includes(cmd)) fail(`prompt.md lost its command: ${cmd}`);
}

// The Quickstart ships the interactive prompt card on the page, and its
// Markdown twin (plus the llms dumps) must stay clean Markdown: the plain
// fence restored, no component tag leaking through.
const quickstartHtml = readFileSync(join(dist, 'getting-started', 'index.html'), 'utf8');
if (!quickstartHtml.includes('agent-prompt')) fail('quickstart lost its prompt card');
const quickstartTwin = readFileSync(join(dist, 'getting-started.md'), 'utf8');
if (!quickstartTwin.includes('prompt.md, then set up Cotal'))
  fail('quickstart twin lost the setup prompt');
for (const cmd of ['npx cotal-ai setup --yes', 'npx cotal-ai up --detach']) {
  if (!quickstartTwin.includes(cmd)) fail(`quickstart lost the runbook command: ${cmd}`);
}
for (const f of ['getting-started.md', 'llms-full.txt', 'llms-small.txt']) {
  if (readFileSync(join(dist, f), 'utf8').includes('AgentPrompt'))
    fail(`AgentPrompt component leaked into ${f}`);
}

// robots.txt must keep its crawl policy (agents are the audience; losing the
// wildcard rule, the Content-Signal declaration, or the sitemap pointer would
// silently drop the site back to "not agent-ready").
const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
for (const directive of [
  'User-agent: *',
  'Content-Signal:',
  'Sitemap: https://docs.cotal.ai/sitemap-index.xml',
]) {
  if (!robots.includes(directive)) fail(`robots.txt lost its directive: ${directive}`);
}

// The agent-skills index must list at least the setup skill, every digest must
// match its artifact, and the setup skill must keep the runbook commands (same
// drift guard as prompt.md above).
const skillsIndex = JSON.parse(
  readFileSync(join(dist, '.well-known', 'agent-skills', 'index.json'), 'utf8'),
);
if (!skillsIndex.skills?.some((s) => s.name === 'cotal-setup'))
  fail('agent-skills index lost the cotal-setup skill');
for (const skill of skillsIndex.skills) {
  const artifact = readFileSync(join(dist, skill.url));
  const digest = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
  if (digest !== skill.digest) fail(`agent-skills digest mismatch for ${skill.name}`);
}
const setupSkill = readFileSync(
  join(dist, '.well-known', 'agent-skills', 'cotal-setup', 'SKILL.md'),
  'utf8',
);
for (const cmd of ['npx cotal-ai setup --yes', 'npx cotal-ai up --detach']) {
  if (!setupSkill.includes(cmd)) fail(`cotal-setup skill lost its command: ${cmd}`);
}

const BAD = /(?:href="|\]\()(?:\.\.\/|docs\/|spec\/|packages\/|extensions\/|implementations\/|examples\/)/;
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '_astro' && entry.name !== 'pagefind') scan(p);
      continue;
    }
    if (!/\.(html|md|txt)$/.test(entry.name)) continue;
    const hit = readFileSync(p, 'utf8').match(BAD);
    if (hit) fail(`repo-relative link leaked into ${p}: ${hit[0]}`);
  }
}
scan(dist);

console.log(
  'check-dist: llms.txt task links present, robots.txt + agent-skills intact, no repo-relative link leaks',
);
