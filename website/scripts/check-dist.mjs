// Post-build sanity checks — fail the build when a generated artifact regresses.
//  1. llms.txt must keep its task-router links (an unlinked llms.txt routes nothing).
//  2. No published page, Markdown twin, or llms set may ship a repo-relative link
//     that only resolves on GitHub (they render 404 on the site).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const fail = (msg) => {
  console.error(`check-dist: ${msg}`);
  process.exit(1);
};

const llms = readFileSync(join(dist, 'llms.txt'), 'utf8');
for (const needle of ['/getting-started.md', '/mcp-tools.md', '/spec.md', '/cotal.schema.json']) {
  if (!llms.includes(needle)) fail(`llms.txt lost its task link to ${needle}`);
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

console.log('check-dist: llms.txt task links present, no repo-relative link leaks');
