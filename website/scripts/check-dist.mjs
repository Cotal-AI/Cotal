// Post-build sanity checks — fail the build when a generated artifact regresses.
//  1. llms.txt must keep its task-router links (an unlinked llms.txt routes nothing).
//  2. No published page, Markdown twin, or llms set may ship a link relative to its
//     own page: one naming a repo path only resolves on GitHub (it renders 404 on the site).
//  3. The agent-readiness surface (robots.txt, the agent-skills index) must keep
//     its directives, and every skill digest must match the artifact it points at.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gfm } from 'micromark-extension-gfm';
import { decodeString } from 'micromark-util-decode-string';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { parse, parseFragment } from 'parse5';
import { isRepoRelative, URL_ATTRS, SRCSET_CANDIDATE, urlInput, parseMarkdown } from './links.mjs';

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

// A link that resolves against its page's own path names a repo file and renders 404 on the site.
// Targets are read from parsed links, never from text, so a code sample that shows a link passes:
// each page as HTML, and the Markdown twins and llms sets as the sync parses Markdown.
const relativeTarget = (name, value) =>
  (name === 'srcset' ? [...value.matchAll(SRCSET_CANDIDATE)].map((c) => c[2]) : [value])
    .map(urlInput)
    .find(isRepoRelative);

function* htmlTargets(node) {
  for (const { name, value } of node.attrs ?? []) {
    const target = URL_ATTRS.has(name) ? relativeTarget(name, value) : undefined;
    if (target !== undefined) yield `${name}="${target}"`;
  }
  // A template holds its children in a separate content fragment, which the page ships too.
  for (const child of (node.content ?? node).childNodes ?? []) yield* htmlTargets(child);
}

function* markdownTargets(text) {
  const { events, html } = parseMarkdown(text, [gfm()]);
  for (const [kind, token, context] of events) {
    const { type, start, end } = token;
    if (kind !== 'enter') continue;
    if (type === 'resourceDestinationString' || type === 'definitionDestinationString') {
      const target = normalizeUri(decodeString(context.sliceSerialize(token)));
      if (isRepoRelative(target)) yield `](${target}`;
    } else if (type === 'htmlFlow' || type === 'htmlText') {
      yield* htmlTargets(parseFragment(html.slice(start.offset, end.offset)));
    }
  }
}

function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '_astro' && entry.name !== 'pagefind') scan(p);
      continue;
    }
    const ext = entry.name.match(/\.(html|md|txt)$/)?.[1];
    if (!ext) continue;
    const text = readFileSync(p, 'utf8');
    const [hit] = ext === 'html' ? htmlTargets(parse(text)) : markdownTargets(text);
    if (hit) fail(`repo-relative link leaked into ${p}: ${hit}`);
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
