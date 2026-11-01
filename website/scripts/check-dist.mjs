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
import { parse } from 'parse5';
import { AGENT_PROMPT } from '@cotal-ai/docs-content/agent-prompt';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const fail = (msg) => {
  console.error(`check-dist: ${msg}`);
  process.exit(1);
};

const llms = readFileSync(join(dist, 'llms.txt'), 'utf8');
if (!llms.includes('## Route by task') || llms.indexOf('## Route by task') > llms.indexOf('## All pages'))
  fail('llms.txt lost task routing above its complete page list');
for (const needle of ['/prompt.md', '/getting-started.md', '/mcp-tools.md', '/spec.md', '/cotal.schema.json']) {
  if (!llms.includes(needle)) fail(`llms.txt lost its task link to ${needle}`);
}

// The agent setup runbook must ship, keep its commands, and stay in step with
// the Quickstart (same commands, so neither can drift alone).
const runbook = readFileSync(join(dist, 'prompt.md'), 'utf8');
for (const cmd of ['npx cotal-ai setup --destination local --harness claude --project . --space main --no-input', 'npx cotal-ai up --root . --space main --detach']) {
  if (!runbook.includes(cmd)) fail(`prompt.md lost its command: ${cmd}`);
}

const quickstartHtml = readFileSync(join(dist, 'docs', 'getting-started', 'index.html'), 'utf8');
const landingHtml = readFileSync(join(dist, 'docs', 'what-is-cotal', 'index.html'), 'utf8');
const textOf = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(textOf).join('');
function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
const promptFigure = find(parse(quickstartHtml), node => node.nodeName === 'figure' &&
  find(node, child => child.nodeName === 'pre' && textOf(child).trim() === AGENT_PROMPT));
if (!promptFigure || !find(promptFigure, node => node.nodeName === 'button' && textOf(node) === 'Copy Text'))
  fail('quickstart lost its native copyable setup prompt');
if (!landingHtml.includes('Set up with your agent. Copy setup prompt') || !landingHtml.includes(AGENT_PROMPT))
  fail('landing page lost its complete copyable setup card');
const landingTwin = readFileSync(join(dist, 'docs/what-is-cotal.md'), 'utf8');
if (!landingTwin.includes('```text wrap\n' + AGENT_PROMPT + '\n```'))
  fail('landing Markdown lost its complete setup prompt');
const quickstartTwin = readFileSync(join(dist, 'docs/getting-started.md'), 'utf8');
if (!quickstartTwin.includes('```text wrap\n' + AGENT_PROMPT + '\n```'))
  fail('quickstart Markdown does not contain the complete setup prompt fence');
if (!quickstartTwin.includes('/docs/setup/')) fail('quickstart lost its link to setup instructions');
const setupTwin = readFileSync(join(dist, 'docs/setup.md'), 'utf8');
for (const cmd of ['npx cotal-ai setup --destination local --harness claude --project . --space main --no-input', 'npx cotal-ai up --root . --space main --detach']) {
  if (!setupTwin.includes(cmd)) fail(`setup lost the runbook command: ${cmd}`);
}
for (const f of ['docs/getting-started.md', 'llms-full.txt', 'llms-small.txt']) {
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
for (const cmd of ['npx cotal-ai setup --destination local --harness claude --project . --space main --no-input', 'npx cotal-ai up --root . --space main --detach']) {
  if (!setupSkill.includes(cmd)) fail(`cotal-setup skill lost its command: ${cmd}`);
}

const BAD = /(?:(?:href|src|srcset)="|\]\()(?:\.\.\/|docs\/|spec\/|packages\/|extensions\/|implementations\/|examples\/)/;
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '_next') scan(p);
      continue;
    }
    if (!/\.(html|md|txt)$/.test(entry.name)) continue;
    const hit = readFileSync(p, 'utf8').match(BAD);
    if (hit) fail(`repo-relative link leaked into ${p}: ${hit[0]}`);
  }
}
scan(dist);

// The installer is served to `curl … | sh`, so its safety properties have to survive the
// build, not just exist in the repo. The invocation must be the brace-wrapped form on the
// last line: a compound command is not executed until its closing brace is parsed, so every
// partial prefix of that line is a syntax error. A bare `main "$@"` would not do, because a
// byte-level truncation can cut it down to a bare `main`, which is a complete command and
// would run the installer with no arguments at all.
const INVOCATION = '{ main "$@"; exit $?; }';
const installer = readFileSync(join(dist, 'install.sh'), 'utf8');
if (!installer.startsWith('#!/bin/sh')) fail('install.sh lost its POSIX sh shebang');
const lastLine = installer.trimEnd().split('\n').pop();
if (lastLine !== INVOCATION)
  fail(`install.sh must end with '${INVOCATION}' for truncation safety, found: ${lastLine}`);
if (installer.split('\n').filter((l) => l.trimEnd() === INVOCATION).length !== 1)
  fail('install.sh must invoke main exactly once, on its last line');
if (/^\s*main\s*("\$@")?\s*$/m.test(installer))
  fail('install.sh has a bare `main` invocation; a truncated download could execute it');
if (!/^set -eu$/m.test(installer)) fail('install.sh lost `set -eu`');
if (!/SHASUMS256\.txt/.test(installer)) fail('install.sh lost its Node checksum verification');

console.log(
  'check-dist: llms.txt task links present, robots.txt + agent-skills intact, install.sh truncation-safe, no repo-relative link leaks',
);
