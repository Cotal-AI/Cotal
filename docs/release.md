# Publishing a release

> **Project** (non-normative maintainer notes) · **For:** maintainers shipping Cotal

Cotal uses [Changesets](https://github.com/changesets/changesets) to version and publish the
workspace packages under `packages/*`, `extensions/*`, and `implementations/*` to npm.
`examples/**` is ignored, since it is not published.

## CI policy

Automatic smoke shards exclude mutation infrastructure suites and print each exclusion. The frozen
inventory and ordinary suite assignments stay unchanged. Build, typecheck, protocol smokes and native
cold-setup checks still run. The Mutation reproof and Windows creation identity workflows are disabled
because they execute mutation proofs; do not re-enable them without an explicit operator request.

## 0.11 runtime migration

The published binary no longer bundles the optional tmux and cmux runtimes. Existing operators
must run `cotal ext add <runtime-package>` once after upgrading,
before using `runtime: tmux|cmux` in a manifest or passing `--runtime tmux|cmux`. Missing runtimes
fail loudly with the matching install command; they never fall back to pty.

## Trusted publishing

Trusted publishing replaces the long-lived `NPM_TOKEN` secret with short-lived OIDC tokens
issued by GitHub Actions. Each published package must be configured once on npmjs.com.

The `fixed` group in [`.changeset/config.json`](../.changeset/config.json) gets versioned together.
The preflight checks that it matches the publishable workspace census.

### Deployment Environment setup

Both publishing jobs (`version` and `snapshot`) reference a GitHub Environment named
`npm-publish`. The OIDC assertion rejects tokens that do not carry this environment claim,
so the Environment must exist and must protect the release ref before the first publish.

1. Go to **Settings > Environments** in the repository.
2. Create a new Environment named **`npm-publish`**.
3. Under **Deployment branches and tags**, select **Selected branches and tags** and add
   `main` as the only allowed branch. This restricts OIDC token issuance to runs on `main`.
4. Optionally add required reviewers if your team wants a manual gate before each release.

The Environment name is embedded in the workflow, in the OIDC identity assertion, and in
every npm trusted-publisher record. All three must use the exact string `npm-publish`.

> **Snapshot releases:** the snapshot job is also bound to the `npm-publish` Environment.
> If the deployment branch policy allows only `main`, snapshot releases from other branches
> are refused by the Environment gate before the OIDC exchange. To allow snapshots from
> additional branches, add those branches to the Environment's deployment policy.

### Per-package trusted publisher configuration

Configure every workspace package that is not `private: true`. The preflight selects them
from `pnpm list -r --depth -1 --json` and prints the package/version census with:

```bash
node scripts/preflight-npm-publish.mjs
```

Without the GitHub OIDC requester, this prints the census and refuses before publishing.
Use that census for the following steps:

1. Go to `https://www.npmjs.com/package/<name>/access` (e.g.
   `https://www.npmjs.com/package/@cotal-ai/core/access`).
2. Scroll to **Trusted publishing** > **Add a trusted publisher**.
3. Pick **GitHub Actions**.
4. Fill in:
   - **Organization or user:** the GitHub owner (your org or user).
   - **Repository:** `Cotal`.
   - **Workflow filename:** `changesets.yml`.
   - **Environment name:** `npm-publish`.
5. Save. Repeat for every package.

> **Migration from blank Environment:** if packages were previously configured with a blank
> Environment name, each must be updated to `npm-publish`. Delete the old trusted publisher
> record and re-create it with the Environment name filled in. The preflight will refuse any
> package whose trusted-publisher record does not carry the `npm-publish` environment.

### Adding a publishable package

A PR that adds a publishable package must have its npm record and trusted publisher created
before the next release cut.

1. A package owner publishes the first version with `npm publish --access=public` and an npm
   token. OIDC cannot create a package. This manual publish is separate from `ci:publish`, which
   refuses npm tokens.
2. Add the trusted publisher for `changesets.yml` with environment `npm-publish`, using the
   [per-package setup](#per-package-trusted-publisher-configuration).
3. Check that the new package appears in the preflight census before the next cut. Re-run a cut
   that was blocked by the missing npm record after completing the setup.

## Day-to-day flow

1. Open a PR that changes code in a publishable package.
2. Add a changeset describing the change:

   ```bash
   pnpm changeset
   ```

   Pick the affected packages plus the semver bump (patch / minor / major), and write a
   one-line summary. Commit the generated `.changeset/<name>.md` file alongside your code
   change. On a branch that has been open for a long time, check that `main` has not already
   shipped the change before you trust its changeset. Merge conflicts in the code the changeset
   describes are the usual sign that it has.
3. Merge to `main`. The only status check `main` requires is `attribution`. The CI aggregate
   jobs `ci-ok`, `windows-ok` and `installer-ok` are advisory: a red one reports and does not
   block the merge, so read them before you merge. `attribution` also refuses the PR until a
   paragraph `Approved-at: <sha>` in its body names the PR's current head by its full sha. Add it
   after you review that head, with a blank line before and after. A line in a code block or an
   HTML comment does not count. A push moves the head, so review the new head and update the line.
   Editing the body re-runs the check. Re-running the job does not, because it replays the old event.
4. The `Changesets` workflow runs:
   - If there are pending changesets, it opens (or updates) a PR titled `chore(release):
     version packages` that bumps versions and updates `CHANGELOG.md` files. The same step
     (`pnpm ci:version`) rebuilds the Claude connector and runs
     `scripts/materialize-claude-plugin.mjs`, which rewrites the committed Claude Code plugin tree
     under `claude-plugin/` with the new bundles and stamps both plugin manifests with the new
     version. Claude Code updates an installed plugin only when that version changes, so a release
     is what delivers a new plugin to installs from the repo's marketplace or a pinned commit.
     Only `dist/mcp.cjs` carries the docs, so `scripts/operator-literal-allowlist.json` lists it
     with the same example counts as `docs/cli.md` and `docs/run-a-mesh.md`. A release that changes
     those counts updates its entries in the release PR.
     The workflow rewrites the PR body each time it updates the PR, so add its `Approved-at` line
     after the last update, just before you merge.
   - When **that** PR is merged, the same workflow builds and qualifies the bumped candidate on
     every native target, then publishes those qualified archives to npm with provenance.

## Correcting a released changelog entry

Changesets only prepends new `## <version>` sections, so an entry in a released section stays as
written unless someone edits it. When a released entry is wrong, add a `**Correction:**` paragraph
under the same bullet, indented two spaces, in every `CHANGELOG.md` that carries the bullet. Keep the
original text, since the GitHub Release for that version already published it. Use the same
wording in each file, because `scripts/release-notes-detail.mjs` dedupes summaries by their text.

## Publication workflow

Normal and snapshot publication both depend on the native cold-setup workflow. It packs every
public package in the fixed group and installs the candidate into an empty home, config and cache
on Linux, macOS and Windows, on x64 and arm64 with Node 22, 24 and 26. Each setup verifies the
installed package bytes, seeds connectors and exercises two broker, delivery and Manager
lifecycles. The checks cover native process pins, Manager control, one-shot shutdown policy,
shutdown cleanup and fresh process generations after restart. Missing or failed results block
publication. Logs and source-bound receipts are retained for each platform.

Before packing, the candidate runs every public package's `prepublishOnly` guard in dependency
order. Packing also runs the package's pack hooks. The packer hashes archive entries in one
read-only stream without extracting files. Native binaries are assembled before these steps.
Every native receipt names the hash of the candidate manifest, whose entries hash the
archives. Publication downloads that immutable candidate and those receipts from the same run,
verifies the whole set, then publishes the archives without rebuilding or rerunning package
scripts. The publication process does not assemble another native binary set.

A snapshot is versioned before these tests. Publication reuses those tested versions rather than
generating a new timestamp after qualification.

`ci:publish` in the root `package.json` is:

- an exact-version census of every package in the Changesets fixed group against the registry;
- a check that the public recursive workspace set is the complete Changesets fixed group;
- one GitHub OIDC exchange per package when the release job exposes the OIDC requester;
- a GET of each package's trusted-publisher document with that exchanged token, which must list
  a direct `npm publish` Allowed action on THIS repository's `changesets.yml` publisher;
- only after those checks, publication of the verified qualified archives with provenance.

The preflight first refuses npm access-token environment variables, before invoking pnpm to
enumerate workspace packages. The registry census prints each package, version, OIDC result and
direct-publish result. If every exact version already exists, the preflight reports a no-op before
OIDC requests. A mixed census, incomplete fixed group, failed OIDC exchange, or stage-only package
exits before `pnpm publish`.

The post-publish closure gate checks every package in the fixed group. Registry observations cannot
distinguish a partial publish from slow propagation: clean 404s and repeated non-404 failures both
lack evidence that a package will never appear. The census therefore reports an incomplete or
errored closure as `UNSETTLED` and never fails the job on its own. Exit 1 remains reserved for future
positive publisher evidence.

Presence on the per-version endpoint does not prove a version installs: `npm install` resolves
through the packument, which can lag that endpoint. Before the GitHub Release is cut, the install
gate installs `cotal-ai@<version>` from the registry into a scratch prefix with a fresh cache and
runs `cotal --version`. A failed attempt before the deadline counts as unknown and is retried every
15 seconds. Once less than two intervals remain, the gate waits half of the remaining time instead,
so the last failed attempt is still retried before the deadline. A version that does not install
and run within 10 minutes fails the job, and no Release is cut:

```bash
node scripts/verify-release-installable.mjs 0.52.0
```

The window in which npm's `latest` tag points at a version whose pinned siblings are not yet
installable opens at publish time, so neither gate can close it. They only keep the announcement
out of it.

When both gates pass, the job cuts the GitHub Release and tag for that version. The Release
targets the oldest commit on `main` whose `bin/package.json` carries the version, which is the
tree the packages were built from. A version that was reverted and carried again keeps that first
commit. A publishing run whose closure gate ends `UNSETTLED` skips the Release, and the next push
that passes both gates cuts it with that same target. The step fails if it cannot read that history
or cannot find that commit.

After the `version` job, the `install-probe` job packs `cotal-ai` and each runtime sibling (every
`workspace:` dependency of `cotal-ai`) and checks that each tarball contains its declared `main` and
string `exports` targets. It then extracts the `cotal-ai` tarball and runs `cotal --version` and
`cotal --help`. The binary runs against the workspace copies of its siblings, so the probe checks
package shape only. It does not cover registry propagation or native assets. Nothing depends on the
job, so a failure reds the workflow without gating the Release:

```bash
node scripts/post-publish-install-probe.mjs
```

Re-check a version that already shipped without publishing, tagging, or changing git:

```bash
node scripts/verify-publish-closure.mjs 0.52.0 --recheck
```

The publish job refuses an npm access token in its environment and publishes through OIDC only.
This prevents pnpm from falling back to a classic token when an OIDC exchange fails.

HTTP 201 from the OIDC exchange is identity only. npm's trusted-publisher Allowed actions always
permit `npm stage publish`; configurations created after 2026-09-03 default to stage and may omit
direct `npm publish`. Both paths use the same successful exchange, so the preflight never treats
that 201 as proof that the sequential per-archive `pnpm publish` can write. Binding those Allowed
actions to a GitHub Environment is done: the `version` and `snapshot` jobs reference `environment:
npm-publish`, and the OIDC identity assertion rejects tokens without the matching
environment claim.

pnpm's `--batch` option was evaluated. It exists from pnpm 11.7 and is all-or-nothing only on a
registry implementing `PUT /-/pnpm/v1/publish` (pnpr does). npm's registry returns 404 for read-only
`GET` and `OPTIONS` probes of that endpoint, and its published Registry API does not document it.
pnpm batch publishing also rejects provenance and requires one shared credential for the batch
instead of the per-package OIDC exchanges used here. The repository stays on the normal npm publish
protocol and treats the preflight as the fail-before-first-write control.

```bash
node scripts/publish-cold-candidate.mjs
```

- The candidate comes from `COLD_CANDIDATE` and the native receipts from `COLD_RESULTS`. Its
  manifest must name the current `HEAD`, and all 18 receipts must name that source and that
  manifest's hash.
- `preflight-npm-publish.mjs`: derive and print the full fixed-group package/version census. In
  addition to each exact version, it reads every package record before any OIDC exchange. A
  missing record refuses the run with the [new-package setup](#adding-a-publishable-package).
  An exchange 404 for an existing package names the missing trusted publisher for this workflow
  and environment. In GitHub Actions it exchanges a package-specific OIDC token, then GETs `/-/package/<name>/trust`
  and refuses unless THIS repository's `changesets.yml` publisher lists a direct-publish Allowed
  action. npm documents that identity on GET `/-/package/<name>/trust` as `claims.repository` and
  `claims.workflow_ref.file` with a `permissions` array. Other GitHub publishers on the same package
  are not proof that this job can publish. It refuses npm access-token environment variables before
  the census or OIDC exchange, so `ci:publish` cannot be used with a classic token.
- Each archive's hash must match the manifest for the whole set before the first write, and again
  just before that archive is published.
- Each archive is published with `pnpm publish <archive> --provenance --access=public
  --no-git-checks --ignore-scripts --tag <tag>`. The tag is `latest`, or the dist-tag the snapshot
  job passes as the script's argument.
- `--ignore-scripts`: package scripts already ran when the candidate was packed.
- `--provenance`: emit SLSA provenance attestations (a no-op without OIDC, automatic with it).
- `--access=public`: required for scoped packages on first publish.
- `--no-git-checks`: skip pnpm's branch / clean-tree guard, since CI does not need it.
