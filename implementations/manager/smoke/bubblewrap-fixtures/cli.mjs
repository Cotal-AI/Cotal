import { registry } from '/app/packages/core/dist/index.js';
import { aclEnv, launchEnv, materialEnv } from '/app/extensions/connector-core/dist/index.js';
import { runCli } from '/app/implementations/cli/dist/index.js';
import '/app/implementations/auth/dist/index.js';
registry.register({
  kind: 'connector', name: 'bubblewrap-fixture', requires: ['node'],
  buildLaunch(opts) {
    const artifacts = [];
    return { command: '/usr/bin/node', args: ['/app/seat.mjs'], artifacts, env: {
      ...launchEnv(), ...aclEnv(opts), ...materialEnv(opts, artifacts),
      COTAL_SPACE: opts.space, COTAL_NAME: opts.name, COTAL_LIFECYCLE_UID: opts.lifecycleUid,
      COTAL_AGENT_FILE: opts.configPath,
    } };
  },
});
await runCli(registry, process.argv.slice(2));
