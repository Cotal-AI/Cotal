import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32', 'this fixture only runs on an owned Windows runner');
const [role, marker, corePath, bindingPath, releasePath] = process.argv.slice(2);
assert(['seat', 'descendant'].includes(role), 'invalid fixture role');
assert(marker && bindingPath && releasePath, 'fixture paths are required');
const { win32ProcessBinding } = await import(pathToFileURL(bindingPath).href);
const binding = win32ProcessBinding();
const token = binding.creationToken(process.pid);
assert(token, 'could not read own process creation token');
const publish = (extra = {}) => {
  writeFileSync(`${marker}.pending`, JSON.stringify({ role, pid: process.pid, token, ...extra }));
  renameSync(`${marker}.pending`, marker);
};
if (role === 'descendant') {
  publish();
} else {
  assert(corePath, 'core package path required');
  const { CotalEndpoint } = await import(pathToFileURL(corePath).href);
  const descendantMarker = `${marker}.descendant`;
  const child = spawn(process.execPath, [process.argv[1], 'descendant', descendantMarker, corePath, bindingPath, releasePath], {
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (error) => {
    writeFileSync(`${marker}.error`, error.stack ?? String(error));
    process.exitCode = 1;
  });
  const e = process.env;
  const ep = new CotalEndpoint({
    space: e.COTAL_SPACE,
    servers: e.COTAL_SERVERS,
    creds: readFileSync(e.COTAL_CREDS, 'utf8'),
    card: { id: e.COTAL_ID, name: e.COTAL_NAME, kind: 'agent' },
    lifecycleUid: e.COTAL_LIFECYCLE_UID,
    channels: [],
    consume: false,
    registerPresence: true,
  });
  ep.on('error', (error) => writeFileSync(`${marker}.endpoint-error`, error.stack ?? String(error)));
  await ep.start();
  publish({ descendantPid: child.pid });
}
// A file-triggered exit is fixture cleanup only, never the product-stop witness.
// It is armed only after the last observation and recorded independently.
const cleanupTimer = setInterval(() => {
  try {
    if (readFileSync(releasePath, 'utf8') === 'release-owned-fixture') process.exit(0);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}, 100);
cleanupTimer.ref();
