# Publishing a release

> **Project** (non-normative maintainer notes) · **For:** maintainers shipping Cotal

Cotal uses pnpm, Changesets and one GitHub Actions workflow. The fixed group in
[`.changeset/config.json`](../.changeset/config.json) versions the public packages together.
Examples are private.

## Prepare the version

Add a changeset for each package change. Breaking changes in these 0.x packages use a minor bump.
Every push to `main` that leaves changesets there runs the Changesets workflow. It opens or updates
the version PR, builds the native binaries and packs the version PR head with them. That pack is the
release; it is ready about four minutes after the merge.

Keep builds and focused upgrade checks ready before the publish command. A successful fresh install
does not prove an upgrade from an existing installation. CI, review rounds and the broad native test
matrix are not publication prerequisites unless the operator requests them.

## Publish

Publish with one command that names the `main` commit the release must include:

```bash
pnpm release:cut <main-sha>
```

It refuses a commit that is not on `main` or carries no changeset. It waits until the version PR
carries the commit, sits on the head of `main` and has its pack, then merges the version PR by its
head commit. Merging the version PR publishes it. The push run of that merge looks up the push run
of the merge's parent commit, checks that its pack was made from the same tree, and uploads that
pack. Nothing is built after the command. A merge of the version PR by any other means publishes in
the same way. A run that finds unpublished versions on `main` but no pack for its tree fails and
publishes nothing.

The command prints one UTC line per step: `command`, `ready`, `merged`, `run`, `published`,
`visible` and `run rc`. The budget is ten minutes from `command` to `visible`, the moment
`npm view cotal-ai@<version> version` answers. The upload ends about two minutes after the merge,
and npm has then taken four to seven minutes to serve the new `cotal-ai` version. A command given
after the pack is ready therefore fits the budget. A command given right after a merge also waits
for that pack.

The workflow uses the maintained Changesets actions to select the release, pack its public packages
and publish the packed artifacts directly to `latest` using the existing publishing authority.
GitHub Actions pins each run to one commit. One upload runs at a time. Direct-mode verification
runs in the following job outside the publisher queue, so its wait does not hold later uploads.
There is no separate qualification or promotion workflow. The optional staging mode below is off
unless the repository variable `COTAL_STAGED_RELEASE` is set to `true`. The preparing run freezes
that mode and records it with the pack, so a later variable edit does not change a prepared release.

Native build jobs produce Cotal's native binaries: the seat binding on Linux x64 and arm64, and the
workspace binding on Windows and macOS, each for x64 and arm64. The pack job assembles those
binaries and builds the packages without npm publishing authority. Only the publish job has the npm trusted
publishing permission. It consumes the packed output rather than rebuilding it. pnpm caches its
lockfile-keyed package store, not built output. The publisher installs only the root tooling.

npm holds an accepted version as staged for several minutes before it serves it, and refuses a
second upload of that version. The patch in `patches/` makes Changesets treat that refusal like an
already published version, so a re-run of a failed publish job skips what npm already holds and
publishes the rest. A transparency-log conflict (`TLOG_CREATE_ENTRY_ERROR`, 409) fails an upload and
passes on a re-run. `pnpm release:cut` therefore re-runs a failed publish job up to twice. If it still
fails, inspect the registry before another retry. A dispatch with
`gh workflow run changesets.yml --ref main` publishes again only while the head of `main` is the
version PR merge. A dispatch while unreleased changesets remain on `main` fails with
`Merge the Changesets version PR before publishing.` and publishes nothing.

The root `ci:publish` command is the standard `pnpm changeset publish`. Maintainers normally use the
workflow so publication has the configured identity and the native binaries are included.

## Verify the result

The publish action reports the packages published and pushes one git tag per package. Direct-mode
verification then checks every exact package version, installs the fixed closure into an isolated
prefix from npm, and runs the CLI in the following job. Default direct publishing updates `latest` during upload, before these checks.
A verification failure stops the GitHub Release but cannot undo those tag updates.

With staging enabled, the complete fixed group is validated and packed under `cotal-staged` using
the standard Changesets plan. Only after successful closure and install checks do ordinary
`npm dist-tag add` commands promote packages in dependency order, with `cotal-ai` last. Failed
verification changes no `latest` tags. A failed promotion stops before later packages and creates
no GitHub Release. Tags are separate registry writes, not an atomic transaction.

The following job cuts one GitHub Release for the version, tagged `v<version>`. Its notes open with
the install command, continue with the changeset summaries, and end with the merged pull requests
since the previous release. If a version has no changelog section or no summaries, the detail
script fails with a diagnostic. The job keeps that stderr, emits a warning, and creates the release
without the optional summaries. Other detail-script failures follow the same non-blocking path.
The Discord announcement follows that release. Check the relevant existing-installation upgrade
before reporting a fix delivered.

An accepted upload and a successful install are separate observations. npm may temporarily return
cached missing-package responses after an upload, and the large `cotal-ai` tarball has taken up to
twenty minutes to become installable, so the install job waits up to twenty-five minutes for that
install. The install check uses a fresh cache and `--prefer-online` to request metadata revalidation.
That does not force npm's upstream caches to converge. Only staged-mode verification keeps the
publisher queue through installation and promotion, so an older delayed staged release cannot
overwrite a newer release's tags. Direct-mode verification stays outside that queue.
If an observation fails, inspect the registry and
the published-package output before retrying. Apart from the re-runs of a failed publish job above,
never repeat an upload whose outcome is unknown.

Keep the original publish-command time. The target is verified availability within ten minutes;
report a missed target rather than resetting the clock or calling a queued job published.

## Configure npm

Every public npm package needs this trusted publisher:

- Repository owner and repository: this repository.
- Workflow filename: `changesets.yml`.
- Environment: `npm-publish`, allowing `main`.
- Allowed action: direct `npm publish`. The default workflow requires no dist-tag management grant.

Staging is not enabled or operationally qualified. Before setting `COTAL_STAGED_RELEASE=true`, the
publisher owner must establish `manageDistTags` for every package's trusted publisher. This is
independent of `createPackage` for direct publication, as npm's
[allowed-action documentation](https://docs.npmjs.com/trusted-publishers/#configuring-allowed-actions)
explains. The registry enforces that authority on each native tag command. No extra trust-settings
read is required: HTTP 401 on a settings read establishes neither write permission nor write denial.
Do not enable the variable until the owner has established the required grant.

npm's separate [staged publishing](https://docs.npmjs.com/staged-publishing/) feature does not replace
this opt-in flow. Its staged contents are unavailable publicly until approval, so they cannot pass
the public-registry closure install check first. `npm stage approve` requires maintainer 2FA and is
not available to an OIDC exchange token, as the
[npm stage command reference](https://docs.npmjs.com/cli/v12/commands/npm-stage) documents.

The workflow uses GitHub OIDC and does not fall back to a long-lived npm token. A missing package or
publisher authorization is an access problem, not permission to borrow credentials.

## Correct release notes

Add a `**Correction:**` paragraph under the affected changelog bullet. Preserve the original text
and use the same correction wording in each affected package so release notes can deduplicate it.
