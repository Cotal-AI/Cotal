import assert from 'node:assert/strict';

/** Only disposable native runners may change install/service masks for a proof cell. */
export function machineShapeOptions(options, { disposable, platform }) {
  const installUmask = options['install-umask'];
  const serviceUmask = options['service-umask'];
  const pinnedNode = options['pinned-node'];
  if (installUmask !== undefined) assert(disposable && platform !== 'win32' && installUmask === '0002', 'install-umask requires disposable POSIX runner and 0002');
  if (serviceUmask !== undefined) assert(disposable && platform === 'linux' && options.state === 'daemon' && serviceUmask === '0002', 'service-umask requires disposable Linux daemon and 0002');
  if (pinnedNode !== undefined) {
    assert(disposable, 'pinned-node requires disposable runner');
    assert.match(pinnedNode, /^\d+\.\d+\.\d+$/, 'pinned-node requires an exact release');
  }
  return { installUmask, serviceUmask, pinnedNode };
}

/** Apply the mask to the actual child, never the shared harness process. */
export function machineShapeCommand(file, argv, installUmask) {
  if (installUmask === undefined) return { file, argv };
  assert.equal(installUmask, '0002');
  return { file: '/bin/sh', argv: ['-c', 'umask 0002; exec "$@"', 'cotal-cell', file, ...argv] };
}
