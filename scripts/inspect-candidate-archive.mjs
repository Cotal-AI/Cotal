import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { list } from 'tar';

// Hash each member while traversing the archive once. Only package.json is buffered.
export function inspectCandidateArchive(archive, maxFileSize = 16 * 1024 * 1024) {
  const files = new Map();
  let metadata;
  list({ file: archive, sync: true, strict: true, onReadEntry(entry) {
    if (!entry.path.startsWith('package/')) throw new Error(`candidate archive must use package prefix: ${entry.path}`);
    const name = entry.path.slice('package/'.length);
    if (isAbsolute(name) || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.')) throw new Error(`unsafe archive member: ${entry.path}`);
    if (entry.type === 'Directory') { entry.resume(); return; }
    if (entry.type !== 'File') throw new Error(`candidate has an unsupported archive entry: ${entry.path}`);
    if (!name || files.has(name)) throw new Error(`candidate has a repeated archive entry: ${entry.path}`);
    files.set(name, null);
    const hash = createHash('sha256'), chunks = name === 'package.json' ? [] : undefined;
    let size = 0;
    entry.on('data', chunk => {
      size += chunk.length;
      if (size > (chunks ? 1024 * 1024 : maxFileSize)) throw new Error(`candidate archive entry exceeds its inspection limit: ${entry.path}`);
      hash.update(chunk);
      chunks?.push(chunk);
    });
    entry.on('end', () => {
      files.set(name, hash.digest('hex'));
      if (chunks) metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    });
  } });
  return { metadata, files: Object.fromEntries(files) };
}
