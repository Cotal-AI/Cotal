# Unattended pre-publish acceptance

This opt-in harness uses unchanged Verdaccio and real authorized Linux fixtures.
It never starts a registry, installs parents, creates units or calls `update --self`.
The coordinator owns provisioning, network access, registry process and cleanup.
Never use production machines or isaac24. Keep all config and evidence private.

Official Verdaccio [configuration](https://verdaccio.org/docs/configuration/) and
[CLI](https://verdaccio.org/docs/cli/) docs describe the standard registry used here.
Run it as a plain process bound to the private test bridge, never a host user unit.
Cotal packages have no upstream proxy. Other dependencies may proxy npm.
Publishing requires a disposable authenticated account and mode-600 private npmrc.
The harness passes its path without inspecting or logging its credentials.

Create a private JSON config, replacing these example values:

```json
{
  "optIn": "unattended-prepublish-6385",
  "evidence": "/home/david/f26/tmp/unattended-case-a",
  "registry": "http://10.227.13.1:14873",
  "candidate": "0.160.6385",
  "publishNpmrc": "/home/david/f26/tmp/u6385/registry.npmrc",
  "key": "/private/test-id",
  "knownHosts": "/private/known_hosts",
  "allowHosts": ["10.0.0.2"],
  "machines": [{
    "host": "10.0.0.2", "hostname": "cotal-test", "user": "ubuntu",
    "existingMachine": "authorized-disposable-6385",
    "root": "/home/ubuntu/proof-case-a",
    "prefix": "/home/ubuntu/.local/share/cotal",
    "cli": "/home/ubuntu/.local/bin/cotal",
    "node": "/home/ubuntu/.local/share/cotal/nodebin/node",
    "unit": "cotal-daemon.service", "parent": "0.160.3", "mode": "success"
  }]
}
```

The evidence parent must exist on physical f26 TMP. Use a fresh suite root.
Local HOME, COTAL_HOME, XDG, npm cache and temporary paths are suite-private.
Only explicit private IPv4 registry origins are accepted.

After the coordinator builds packages, run `node scripts/unattended-prepublish.mjs
prepare <config.json>`. It reuses the cold packer and its prepublish guards, retains
the original public closure and hashes, then extracts into private staging. Only
copied manifests change: one higher stable version, closure dependency/optional/
peer ranges, and private publishConfig registry. Built file hashes must match.
Repacking disables lifecycle scripts. Source manifests and built artifacts stay
unchanged. These candidates must never reach a public registry.

The optional `config` action emits a Verdaccio YAML template. The coordinator
provisions htpasswd separately. With the registry ready, the coordinator runs
`publish <config.json>`. All archive hashes are validated before publishing to
the explicit private registry, using its npmrc. `cotal-ai` is last. Inspect registry
state before retrying a partial publish. Retain the registry log and its hash.

## Real machines

Only the coordinator's explicitly authorized disposable ubuntu fixtures qualify.
Use the existing installation, launcher, account HOME and native daemon unit.
Do not replace their environment or prefix to prepare the proof. The configured
root is a fresh evidence directory under `/home/ubuntu`, created by the coordinator.
No owner-PC npm config is touched. Preserve old parents with automatic updates off.

`run <config.json>` uses strict pinned SSH host keys and the configured Node path.
It checks the actual hostname, existing parent version, active native unit,
ready daemon, CLI version, MainPID, process start identity and cgroup membership.
It saves fixture npmrc and automatic-policy bytes privately as `restore-policy.json`,
points user npm registry and scope at the private registry, and enables automatic
updates. It advances only existing check/attempt clock fields, waits for the real
registry observation, then advances release-hold time. It does not synthesize
latest, version, result or failure records, change the unit or invoke installation.

Three consecutive observations must show the expected daemon and CLI version,
stable PID/start identity, active unit and matching cgroup, completed attempt,
cleared recovery journal (null tombstone allowed) and absent child marker.
Success requires a new daemon identity. For rollback use a separate suite with
`mode: "rollback"` and a genuine candidate whose normal install or readiness fails.
Arrange that failure in the disposable environment, without product mutations or
archive corruption. Passing requires the restored parent and recorded rollback,
not merely an old daemon that never attempted replacement.

A `finally` block restores fixture npmrc bytes. On success it restores policy bytes.
On failure it leaves automatic updates off and retains the original policy backup.
If SSH is interrupted,
the coordinator restores from the private backup after inspecting live ownership.
Versions and scheduler clocks remain for diagnosis, not silently reverted.
Logs retain status, unit identity, attempts, updater output and journal with hashes.
`results.json` records machine outcomes and log hashes. Keep the tested Git head,
candidate manifests and registry log/hash alongside them. Cleanup belongs to the
coordinator after all suite processes are quiescent.

`node scripts/unattended-prepublish.smoke.mjs` checks guards offline. It is not
real-machine acceptance. The coordinator runs old-parent and new-parent suites.
