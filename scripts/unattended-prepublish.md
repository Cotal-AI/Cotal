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

Set `sourceDirectory` to a fresh owned copy such as
`/home/david/f26/tmp/u6385/candidate6386-source` and candidate to `0.160.6386`.
Run `stage-source <config.json>` before any build. It exports tracked HEAD, records
its archive hash, and changes only public package manifests in that copy. Versions
and first-party ranges advance together, workspace protocols remain for pnpm's
normal packing, and private publishConfig disables public OIDC provenance.
Plugin metadata using an independent `0.0.0` version is left unchanged.
The source-stage receipt lists every changed manifest and before/after hashes.

The coordinator runs normal `pnpm install --no-frozen-lockfile` in the copied tree
to synchronize the lockfile, then the normal full build. Use suite-private HOME,
COTAL_HOME, XDG and TMP variables. Preserve the lockfile and its hash. Select and
assemble source-matched native artifacts through the existing release scripts.
Do not copy generated bundles from an older version or edit JavaScript literals.
Then run `prepare <config.json>`. It invokes the unchanged cold packer against the
copy, including prepublish and prepack guards, with no postpack version rewriting.
It audits top-level and nested seeded first-party manifests, exact dependencies,
private publishConfig and generated DOCS_VERSION constants. The retained identity
audit and archive/file hash manifest must match the candidate. These private
candidates must never reach a public registry.

The optional `config` action emits a Verdaccio YAML template with
`max_body_size: 200mb` for the built CLI archive. The default request limit can
reject it with HTTP 413 after smaller packages were accepted. Retry only the
rejected archive after inspecting registry state, never the immutable versions
already published. The coordinator
provisions htpasswd separately. With the registry ready, the coordinator runs
`publish <config.json>`. All archive hashes are validated before publishing to
the explicit private registry, using its npmrc. `cotal-ai` is last. Inspect registry
state before retrying a partial publish. Retain the registry log and its hash.

## Parent archives

Before machine acceptance add `parentVersions`, for example `["0.160.3", "0.160.4"]`,
and run `mirror-parents <config.json>` in a fresh evidence root. The updater checks
parent rollback archives before replacement. Missing parents are a setup failure,
not proof of an updater defect. The mirror downloads the full public package census
and its first-party closure from HTTPS registry.npmjs.org, verifies upstream SRI,
checks archive identities and dependency policy, and retains metadata, origins and
SHA-256 hashes. No tarball is modified. Embedded registry overrides are refused.
Only private writes use the opaque publisher npmrc, disabled provenance and
`parent-<version>` tags. Candidate latest is checked before and after publication.
On partial failure use a fresh evidence root. Existing versions are skipped only
when upstream integrity and parent tag match. Any mismatch or ambiguous lookup
refuses rather than republishing. Do not enable upstream proxying for Cotal.

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
