# Publishing a release

> **Project** (non-normative maintainer notes) · **For:** maintainers shipping Cotal

Cotal versions its public packages together with Changesets. The fixed group in
[`.changeset/config.json`](../.changeset/config.json) matches the public workspace packages.
Examples are private.

## Execute the publication

On an explicit publish command, publish the requested source without waiting for CI, review rounds
or a native test matrix. Those are not release gates. The user removed these waiting requirements
on 22 October 2026. Useful tests can run separately; report their actual results.

Keep one publisher and the original command time. The target is verified registry availability
within ten minutes. Never restart that clock or call a queued job published. Report a concrete
platform or permission refusal immediately.

The `Changesets` workflow publishes through GitHub OIDC from `main`, using the `npm-publish`
Environment. The publisher still requires authorized credentials, the requested source, coherent
package versions and intact archives. It does not fall back to an npm access token.

## Prepare package versions

Add a changeset for each package change. Breaking changes in these 0.x packages use a minor bump.
The push-only version job prepares the version PR. Merge the intended version update; do not wait
for advisory CI. Maintainer-prepared commits and PRs omit AI/tool credits. Other contributors may
acknowledge their agents.

The Attribution workflow and its required-status rule are removed. An `Approved-at` paragraph is
not required. The automatic CI, Windows, Docs, Installer and Cold setup workflows are disabled;
their scripts remain available for explicitly requested checks.

## Publish directly

The source must already carry the requested version and be a first-parent commit on `main`.
Use successful native builder artifacts from that same source. The overall test run does not need
to pass: the publisher consumes its four native build outputs, not a matrix qualification receipt.

```bash
gh workflow run changesets.yml --ref main \
  -f "version=<version>" \
  -f "source=<main-source-sha>" \
  -f "native_run=<native-build-run-id>" \
  -f "requested_at=<original-UTC-timestamp>"
```

An optional `-f tag=next` publishes an already-versioned snapshot without making a GitHub Release.
Do not generate a different version after the command.

The workflow checks out that immutable source, builds it in an environment without publishing
credentials, assembles the source-matched Linux and Windows native binaries, and packs the public
package census. It retains native architecture, source and archive-integrity checks. Missing native
build outputs require building those outputs, not rerunning an unrelated test matrix.

`direct-release.mjs` publishes the resulting archives through the package-specific OIDC preflight.
At most four sibling archives upload together; `cotal-ai` uploads after the siblings. The requested
tag cannot move backwards. Package hooks do not run during upload.

## Verify the result

The publisher reads back every archive and dist-tag, comparing SHA-256 and registry SHA-512 integrity
with the bytes it uploaded. That is the availability evidence. An accepted upload alone is not
publication. The workflow announces the verified normal release and then observes a fresh install;
that install does not hold already-published packages behind another approval.

The publication receipt records individual not-started, running, accepted, refused and unknown
outcomes. An interrupted client may have uploaded its package. Inspect registry state and the
receipt before another write; do not blindly repeat unknown writes.

The original timestamp remains in the receipt. Late availability is reported as late rather than
being relabelled as a timely release. Each execution attempt has a bounded runtime, shared across
its build, upload and availability work.

## Package publisher setup

Every public npm package needs this trusted publisher:

- Repository owner and repository: this repository.
- Workflow filename: `changesets.yml`.
- Environment: `npm-publish`, allowing `main`.

Adding a new public package also requires its initial npm record; OIDC cannot create a package.
A missing authorization or npm refusal is an access problem, not permission to borrow credentials.

## Correcting release notes

Add a `**Correction:**` paragraph under the affected changelog bullet. Preserve the original text
and use the same correction wording in each affected package so release notes can deduplicate it.
