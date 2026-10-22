# Publishing a release

> **Project** (non-normative maintainer notes) · **For:** maintainers shipping Cotal

Cotal uses pnpm, Changesets and one GitHub Actions workflow. The fixed group in
[`.changeset/config.json`](../.changeset/config.json) versions the public packages together.
Examples are private.

## Prepare the version

Add a changeset for each package change. Breaking changes in these 0.x packages use a minor bump.
The Changesets workflow opens or updates the version PR after a change reaches `main`.
Merge the intended version update before publishing.

Keep builds and focused upgrade checks ready before the publish command. A successful fresh install
does not prove an upgrade from an existing installation. CI, review rounds and the broad native test
matrix are not publication prerequisites unless the operator requests them.

## Publish

Run the workflow on the versioned `main` commit:

```bash
gh workflow run changesets.yml --ref main
```

The workflow uses the maintained Changesets actions to select the release, pack its public packages
and publish the packed artifacts. GitHub Actions pins the run to one commit. One publication runs at
a time. There is no separate qualification or promotion workflow.

Linux and Windows build jobs produce Cotal's native binaries. The pack job assembles those binaries
and builds the packages without npm publishing authority. Only the publish job has the npm trusted
publishing permission. It consumes the packed output rather than rebuilding it.

The root `ci:publish` command is the standard `pnpm changeset publish`. Maintainers normally use the
workflow so publication has the configured identity and the native binaries are included.

## Verify the result

The publish action reports the packages published and pushes one git tag per package. The workflow
then cuts one GitHub Release for the version, tagged `v<version>`: its notes open with the install
command, continue with the changeset summaries of what changed, and end with the merged pull
requests since the previous version release. The Discord announcement follows that release. The
workflow then installs the published CLI into an isolated prefix and runs it. Check that result and the
relevant existing-installation upgrade before reporting the fix delivered.

An accepted upload and a successful install are separate observations. npm may temporarily return
cached missing-package responses after an upload, and the large `cotal-ai` tarball has taken up to
twenty minutes to become installable, so the workflow waits up to twenty-five minutes for that
install. If an observation fails, inspect the registry and
the published-package output before retrying. Never blindly repeat an upload whose outcome is unknown.

Keep the original publish-command time. The target is verified availability within ten minutes;
report a missed target rather than resetting the clock or calling a queued job published.

## Configure npm

Every public npm package needs this trusted publisher:

- Repository owner and repository: this repository.
- Workflow filename: `changesets.yml`.
- Environment: `npm-publish`, allowing `main`.

The workflow uses GitHub OIDC and does not fall back to a long-lived npm token. A missing package or
publisher authorization is an access problem, not permission to borrow credentials.

## Correct release notes

Add a `**Correction:**` paragraph under the affected changelog bullet. Preserve the original text
and use the same correction wording in each affected package so release notes can deduplicate it.
