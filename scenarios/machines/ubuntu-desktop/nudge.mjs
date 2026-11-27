// The shared folder carries no file-change events from the host into the VM, so the dev app's
// watchers (vite for the window, tauri for the Rust side) would miss edits made on the host.
// This watches the checkout's desktop folder on the host and touches each changed file inside the
// VM, which the VM's watchers do see. Usage: node nudge.mjs <vm> <host checkout> <vm checkout>
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';

const [vm, hostRepo, vmRepo] = process.argv.slice(2);
const root = join(hostRepo, 'desktop');
const skip = /(^|\/)(node_modules|target|dist|\.git)(\/|$)|(^|\/)src-tauri\/(runtime|binaries|\.runtime-stage-)/;
const seen = new Map();
let pending = new Set();
let timer;

function digest(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

function flush() {
  const paths = [...pending].filter((rel) => {
    const now = digest(join(root, rel));
    if (now === null || seen.get(rel) === now) return false;
    seen.set(rel, now);
    return true;
  });
  pending = new Set();
  if (!paths.length) return;
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    execFile('lxc', ['exec', vm, '--', 'touch', '-c', '--', ...batch.map((rel) => `${vmRepo}/desktop/${rel}`)], (error) => {
      console.log(`${new Date().toISOString()} ${error ? `failed: ${error.message}` : 'touched'} ${batch.join(' ')}`);
    });
  }
}

watch(root, { recursive: true }, (_event, rel) => {
  if (!rel || skip.test(rel)) return;
  pending.add(rel);
  clearTimeout(timer);
  timer = setTimeout(flush, 150);
});
console.log(`watching ${root} for ${vm}`);
