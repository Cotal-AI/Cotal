import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat().sort();

function inspect(directory) {
  const bytes = readFileSync(join(directory, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  assert.match(manifest.source, /^[a-f0-9]{40}$/, 'immutable source SHA required');
  assert.equal(expected.length, 24, 'expected 24 first-party packages');
  assert.deepEqual(manifest.packages.map(pkg => pkg.name).sort(), expected, 'complete unique package census required');
  assert.equal(new Set(manifest.packages.map(pkg => pkg.archive)).size, 24, 'archive basenames must be unique');
  for (const pkg of manifest.packages) assert.match(pkg.sha256, /^[a-f0-9]{64}$/, 'archive SHA256 required');
  const versions = [...new Set(manifest.packages.map(pkg => pkg.version))];
  assert.equal(versions.length, 1, 'closure must be lockstep');
  assert.match(versions[0], /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'stable numeric version required');
  return { manifest, version: versions[0], hash: sha256(bytes) };
}

/** Keep both immutable closures readable while switching only the latest tag. */
export async function candidatePairRegistry(sourceDirectory, targetDirectory, upstream = 'https://registry.npmjs.org/') {
  const source = inspect(sourceDirectory), target = inspect(targetDirectory);
  assert.equal(source.manifest.source, target.manifest.source, 'pair must share source SHA');
  const [major, minor, patch] = source.version.split('.').map(Number);
  assert([major, minor, patch, patch + 1000].every(Number.isSafeInteger), 'version exceeds safe numeric ordering');
  assert.equal(target.version, `${major}.${minor}.${patch + 1000}`, 'target must be deterministic source patch+1000');
  let a, b, server, latest = source.version, closing;
  const requests = [], cache = new Map();
  try {
    a = await candidateRegistry(sourceDirectory, 'A', upstream);
    b = await candidateRegistry(targetDirectory, 'B', upstream);
    server = createServer(async (request, response) => {
      try {
        if (request.method !== 'GET') { response.writeHead(405).end('read-only candidate pair registry'); return; }
        const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
        requests.push({ at: new Date().toISOString(), path });
        const name = path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0];
        const selector = path.slice(name.length + 1);
        if (!expected.includes(name) || path.includes('/-/')) {
          const result = await fetch(`${a.url}/${request.url.slice(1)}`, { signal: AbortSignal.timeout(30000) });
          response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'application/octet-stream' }).end(Buffer.from(await result.arrayBuffer()));
          return;
        }
        if (!cache.has(name)) {
          const pending = Promise.all([a, b].map(async registry => {
            const result = await fetch(`${registry.url}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(35000) });
            assert(result.ok, `candidate metadata unavailable for ${name}: ${result.status}`);
            return result.json();
          })).then(([left, right]) => {
            assert.equal(left.versions[source.version]?.version, source.version, 'missing source metadata');
            assert.equal(right.versions[target.version]?.version, target.version, 'missing target metadata');
            return { ...left, versions: { ...left.versions, ...right.versions, [source.version]: left.versions[source.version], [target.version]: right.versions[target.version] } };
          });
          cache.set(name, pending);
          pending.catch(() => cache.delete(name));
        }
        const metadata = structuredClone(await cache.get(name));
        metadata['dist-tags'] = { ...metadata['dist-tags'], latest };
        const body = selector ? metadata.versions[metadata['dist-tags'][selector] ?? selector] : metadata;
        response.writeHead(body ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body ?? { error: 'version not found' }));
      } catch (error) { response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message })); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return {
      url: `http://127.0.0.1:${server.address().port}`,
      identity: { source: source.manifest.source, sourceVersion: source.version, targetVersion: target.version,
        sourceManifestSha256: source.hash, targetManifestSha256: target.hash,
        sourceArchives: a.identity.archives, targetArchives: b.identity.archives },
      requests,
      activateTarget() { assert(!closing, 'registry is closing'); latest = target.version; },
      close() {
        closing ??= (async () => {
          await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          await Promise.all([a.close(), b.close()]);
          return requests;
        })();
        return closing;
      },
    };
  } catch (error) {
    await Promise.allSettled([a?.close(), b?.close()]);
    throw error;
  }
}
