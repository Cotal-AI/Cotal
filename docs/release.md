# Publishing a release

> **Project** (non-normative maintainer notes) · **For:** maintainers shipping Cotal

Cotal releases with pnpm, Changesets, and one GitHub Actions workflow, `changesets.yml`. The fixed
group in [`.changeset/config.json`](../.changeset/config.json) versions the public packages
together. Examples are private and never publish.

## Prepare the version

Add a changeset with each package change. These packages are 0.x, so a breaking change takes a
minor bump. Write its first sentence as a headline a user can understand on its own. The GitHub
Release and Discord announcement lead with that sentence; put the mechanism after it.

Every push to `main` that leaves changesets there runs the Changesets workflow. The workflow opens
or updates the version PR and packs its head with all native binaries. That pack is the release.

Unchanged native inputs can reuse a complete, unexpired artifact set from a successful `main` push
of this repository's Changesets workflow. Source files, SDK pins, build scripts, install inputs and
build instructions must match; the packing checkout checks them again. The original builder commit
stays in each receipt, and the existing architecture, binary-hash and source-hash checks still run.
Lockfile matching covers the seat and workspace importers, linked workspace importers, and all
reachable package and snapshot entries, including peer and optional dependencies. Shared resolution
settings still match in full. Unrelated importer or package changes do not require new native builds.
Unsupported lockfile versions, dependency forms or incomplete dependency graphs refuse reuse.
No receipt is rewritten to name the application release commit. Changed inputs or missing artifacts
require fresh native builds; an API or validation failure refuses rather than using unverified bytes.

Before you run the publish command, have the builds and a focused upgrade check ready. Run
`pnpm smoke:manager-runtime-deps` after building. It checks every published package's emitted
JavaScript against its production dependency declarations, including cold dynamic imports.
A fresh
install that succeeds does not prove that an existing installation upgrades. CI, review rounds,
and the broad native test matrix are not required to publish unless the operator asks for them.

## Publish

Run one command that names the `main` commit the release must include:

```bash
pnpm release:cut <main-sha>
```

The command refuses a commit that is not on `main`, and a commit that carries no changeset. It
then waits until the version PR carries the commit, sits on the head of `main`, and has its pack.
Then it merges the version PR by its head commit.

That merge publishes the release. The workflow run for the merge finds the run for the merge's
parent commit, checks that the parent run built its pack from the same tree, and uploads that
pack. Nothing is built after the command. A merge of the version PR by any other means publishes
the same way. A run that finds unpublished versions on `main` but no pack for its tree fails and
publishes nothing.

Before publishing in either release mode, the job polls the current run's artifact listing for
the new pack's upload id, name and unexpired state. It tries up to 30 times, two seconds apart,
within a two-minute step limit. An API failure or a pack that stays absent fails the job before
the publish action runs.

The command prints one UTC line for each step: `command`, `ready`, `merged`, `run`, `published`,
`visible`, and `run rc`. The budget is ten minutes from `command` to `visible`. `visible` is the
moment that `npm view cotal-ai@<version> version` answers. The upload ends about two minutes after
the merge, and npm has then taken four to seven minutes to serve the new `cotal-ai` version. A
command that you run after the pack is ready fits the budget. A command that you run right after a
merge also waits for that merge's pack.

Measure from the original `command` time. The target is verified availability within ten minutes.
If you miss it, report the miss. Don't reset the clock, and don't call a queued job published.

## Recover from a failed publish

npm accepts an upload but waits several minutes before it serves the version, and it refuses a
second upload of that version. The patch in `patches/` makes Changesets treat that refusal as an
already published version. A re-run of a failed publish job therefore skips what npm already holds
and publishes the rest.

A transparency-log conflict (`TLOG_CREATE_ENTRY_ERROR`, HTTP 409) fails an upload, and the same
upload passes on a re-run. For that reason, `pnpm release:cut` re-runs a failed publish job up to
twice. If the job still fails, inspect the registry before you retry again.

To publish again from a dispatch, run:

```bash
gh workflow run changesets.yml --ref main
```

A dispatch publishes only while the head of `main` is the version PR merge. A dispatch while
unreleased changesets remain on `main` fails with
`Merge the Changesets version PR before publishing.` and publishes nothing.

Apart from these re-runs of a failed publish job, never repeat an upload whose outcome is unknown.
Inspect the registry and the published-package output first.

## Verify the result

The publish action reports the packages it published and pushes one git tag per package. A
following job then runs direct-mode verification. It checks every exact package version, installs
the fixed closure from npm into an isolated prefix, and runs the CLI.

Direct publishing, the default, updates `latest` during the upload, before these checks run. A
verification failure stops the GitHub Release, but it cannot undo those tag updates.

An accepted upload and a successful install are separate observations. After an upload, npm can
return cached missing-package responses for a while. The large `cotal-ai` tarball has taken up to
twenty minutes to become installable, so the install job waits up to twenty-five minutes for the
install to succeed. The closure census before it waits as long, so a late `cotal-ai` does not
fail the job and skip the Release. The install check uses a fresh cache and `--prefer-online` to
ask npm to revalidate metadata. That does not force npm's upstream caches to converge.

The next job cuts one GitHub Release for the version, tagged `v<version>`. Its notes open with the
install command and a restart reminder, then `## What changed`: one sentence per change, major and
minor changes before patches. Full summaries follow in a collapsed block, then the merged pull
requests. The summaries cover versions since the previous Release, including versions that never
received a Release, and are deduplicated across packages. Both layers keep whole changes within
the remaining release-body byte budget and name any omissions.

The job installs the Markdown parser from the workspace lockfile. If that installation fails, a
version has no changelog section or summaries, or the detail script fails otherwise, the job keeps
the diagnostic, emits a warning, and creates the release without the optional summaries. These
steps do not add a publication gate.

The Discord announcement carries only the `## What changed` bullets and an upgrade command, links
to the Release, and drops whole bullets to stay within the embed limit. It refuses a body without
that section. The request reads the webhook credential in-process, never from a command argument,
and prints no request error that could contain the credential. Redirects are refused and failed
requests are not retried automatically; check Discord before retrying an unknown delivery.

Before you report a fix as delivered, check the upgrade from an existing installation that the fix
affects.

## How the workflow publishes

The workflow uses the maintained Changesets actions to select the release, pack its public
packages, and publish the packed artifacts directly to `latest` with the existing publishing
authority. There is no separate qualification or promotion workflow.

- GitHub Actions pins each run to one commit.
- One upload runs at a time.
- Direct-mode verification runs in a later job outside the publisher queue, so its wait does not
  hold later uploads.

Native build jobs produce Cotal's native binaries:

- The seat binding, on Linux for x64 and arm64.
- The workspace binding, on Windows and macOS for x64 and arm64.

The pack job assembles those binaries and builds the packages. It has no npm publishing authority.
Only the publish job has the npm trusted-publishing permission, and it uploads the packed output
without rebuilding it. pnpm caches its package store, keyed by the lockfile, and never caches built
output. The publisher installs only the root tooling.

The root `ci:publish` command is the standard `pnpm changeset publish`. Maintainers publish through
the workflow instead, so that the release has the configured identity and includes the native
binaries.

## Configure npm

Every public npm package needs this trusted publisher:

- Repository owner and repository: this repository.
- Workflow filename: `changesets.yml`.
- Environment: `npm-publish`, allowing `main`.
- Allowed action: direct `npm publish`. The default workflow needs no grant to manage dist-tags.

The workflow authenticates with GitHub OIDC and never falls back to a long-lived npm token. A
missing package or a missing publisher authorization is an access problem. It is not permission to
borrow other credentials.

## Staged mode

Staged mode is optional, off by default, and not yet qualified for use. It is on only when the
repository variable `COTAL_STAGED_RELEASE` is `true`. The run that prepares a pack freezes the mode
and records it with the pack, so a later edit of the variable does not change a prepared release.

In staged mode, the workflow validates the complete fixed group and packs it under the
`cotal-staged` dist-tag, using the standard Changesets plan. After the closure and install checks
pass, ordinary `npm dist-tag add` commands promote the packages in dependency order, with
`cotal-ai` last.

- A failed verification changes no `latest` tag.
- A failed promotion stops before the later packages and creates no GitHub Release.
- Each tag is a separate registry write, so promotion is not an atomic transaction.
- Staged-mode verification holds the publisher queue through installation and promotion, so an
  older delayed staged release cannot overwrite the tags of a newer release.

Before anyone sets `COTAL_STAGED_RELEASE=true`, the publisher owner must grant `manageDistTags` on
every package's trusted publisher. That grant is separate from `createPackage`, which direct
publishing uses, as npm's
[allowed-action documentation](https://docs.npmjs.com/trusted-publishers/#configuring-allowed-actions)
explains. The registry checks the grant on each dist-tag command, so no separate read of the trust
settings is needed. An HTTP 401 on a settings read shows neither that a write is allowed nor that
it is denied. Don't enable the variable until the owner has granted `manageDistTags`.

npm's own [staged publishing](https://docs.npmjs.com/staged-publishing/) feature does not replace
staged mode. npm keeps staged contents private until someone approves them, so they cannot pass the
closure install check against the public registry first. `npm stage approve` also requires
maintainer 2FA, and an OIDC exchange token cannot run it, as the
[npm stage command reference](https://docs.npmjs.com/cli/v12/commands/npm-stage) documents.

## Correct release notes

Add a `**Correction:**` paragraph under the affected changelog bullet, and keep the original text.
Use the same correction wording in each affected package, so that the release notes can
deduplicate it.

## Earlier section links

These links lead to the current guidance for sections renamed in earlier versions.

### Publication deadline [#publication-deadline]

See [Publish](#publish).

### CI policy [#ci-policy]

See [Prepare the version](#prepare-the-version).

### Trusted publishing [#trusted-publishing]

See [Configure npm](#configure-npm).

### Adding a publishable package [#adding-a-publishable-package]

See [Configure npm](#configure-npm).

### Preparing a release [#preparing-a-release]

See [Prepare the version](#prepare-the-version).

### Publishing the prepared candidate [#publishing-the-prepared-candidate]

See [Publish](#publish).

### Publication controls [#publication-controls]

See [Publish](#publish).

### Verifying availability [#verifying-availability]

See [Verify the result](#verify-the-result).

### Recovering late registry visibility [#recovering-late-registry-visibility]

See [Verify the result](#verify-the-result).

### Correcting a released changelog entry [#correcting-a-released-changelog-entry]

See [Correct release notes](#correct-release-notes).

### 0.11 runtime migration [#011-runtime-migration]

See [Prepare the version](#prepare-the-version).
