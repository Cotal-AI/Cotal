// usage: node make-oracle.mjs <repo> <out.json>  (read-only over the built tree; independent source check for the page)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDocument } from '@cotal-ai/docs-content';
const [repo, out] = process.argv.slice(2);
const docs = await import(pathToFileURL(join(repo, 'extensions/connector-core/dist/docs.js')).href);
const version = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
const sha = s => createHash('sha256').update(s).digest('hex');
const entry = async args => { const r = await docs.runDocs(args); if (r.isError) throw new Error('oracle call failed'); return { sha256: sha(r.text), bytes: Buffer.byteLength(r.text), text: r.text }; };
const index = await entry({}), page = await entry({ page: 'manifest' }), search = await entry({ query: 'personaPermissions' });
const manifest = (await readDocument(join(repo, 'docs/manifest.mdx'))).markdown;
if (page.text !== `(bundled v${version})\n\n${manifest}`) throw new Error('page oracle differs from the independent source file');
if (!index.text.startsWith(`# Cotal v${version} documentation`) || !search.text.startsWith(`# Cotal v${version} docs: top matches for "personaPermissions"`)) throw new Error('index or search oracle header differs');
const strip = ({ sha256, bytes }) => ({ sha256, bytes });
writeFileSync(out, JSON.stringify({ version, workloads: { index: strip(index), page: strip(page), search: strip(search) } }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ version, index: index.bytes, page: page.bytes, search: search.bytes }));
