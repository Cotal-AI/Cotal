# Publishing a release

> **Project** (non-normative maintainer notes) · **For:** maintainers shipping Cotal

Cotal uses [Changesets](https://github.com/changesets/changesets) to version its public workspace
packages. The fixed group in [`.changeset/config.json`](../.changeset/config.json) must match every
public workspace package. Examples are not published.

## Publication deadline

The standing publication deadline is ten minutes from the human publish command to verified
registry availability. Record that command's UTC timestamp immediately. Merging, entering a runner,
uploading packages and retrying must not reset it. One owner runs publication.

Finish source review, versioning, native qualification and any release-readiness holds before the
command. Do not add serial reviews, unrelated changes, another native matrix or advisory-CI waits
after it. Keep security, credential and repository protections. Report a platform refusal or a
missed deadline rather than calling an accepted upload a published release.

GitHub runner admission and npm propagation are external dependencies. The workflow enforces the
original deadline and records breaches; it cannot guarantee those services' response times. A local
smoke or dry run is not production evidence for the ten-minute target.

## CI policy

Automatic smoke shards exclude mutation infrastructure and print each exclusion. Build, typecheck,
protocol smokes and native cold setups still run. The Mutation reproof and Windows creation identity
workflows are disabled because they execute mutation proofs. Do not re-enable them without an
explicit operator request.

## Trusted publishing

The main-only `version` job publishes normal and snapshot releases through GitHub OIDC. It uses the
`npm-publish` Environment. Create that Environment with `main` as its allowed deployment branch
before the first publication. A configured approval hold is a readiness blocker, not permission to
disable protection to meet the deadline.

Every public package needs a trusted publisher configured on npmjs.com:

- Organization or user: the repository owner.
- Repository: `Cotal`.
- Workflow filename: `changesets.yml`.
- Environment name: `npm-publish`.

Use `https://www.npmjs.com/package/<name>/access` and **Trusted publishing > Add a trusted publisher**.
Repeat for every public package. A former publisher with a blank Environment must be replaced with
one naming `npm-publish`. Snapshots use the same main-only publisher, not a less-protected branch.

Inspect the derived census without writing packages:

```bash
node scripts/preflight-npm-publish.mjs
```

Without the GitHub OIDC requester, an absent-version census refuses before publication. An
all-present census returns a no-op before OIDC. The preflight rejects npm access-token environment
variables before invoking pnpm, so an OIDC refusal cannot fall back to a classic token.

### Adding a publishable package

A new public package needs its npm record and trusted publisher before release preparation finishes.

1. Its owner publishes the first version with `npm publish --access=public` and an npm token. OIDC
   cannot create a package. This is separate from `ci:publish`, which refuses npm tokens.
2. Configure the package's trusted publisher with `changesets.yml` and `npm-publish`.
3. Check that the package appears in the complete preflight census.

## Preparing a release

1. Add a changeset with each public package change. Packages are 0.x, so a breaking change is minor.
   List every affected first-party package and describe the change. Check whether an older branch's
   change has already shipped before keeping its changeset.
2. Merge reviewed source to `main`. The required `attribution` check needs a current
   `Approved-at: <sha>` paragraph in the PR body. Add it after reviewing that head, outside code
   blocks and HTML comments. A new push requires a new review and paragraph. Advisory checks report
   results but do not require waiting for terminal-green CI.
3. The push-only `Changesets` job opens or updates the version PR. `pnpm ci:version` bumps package
   versions, updates changelogs, rebuilds the Claude connector and materializes the committed plugin
   bundles and manifests. The action rewrites the PR body, so add its current approval after its last
   update. Keep generated operator-literal counts current when their examples change.
4. Finish the version PR's native `Cold setup` run and independent source reviews. Use a successful
   first attempt, not artifacts mixed across partial reruns. A fresh run is the remedy for an
   ineligible rerun. Merge the eligible version PR before publish-go.
5. Save the v2 qualification receipt's version and run ID, candidate manifest SHA-256, public
   signature bundle, original source and source tree, immutable artifact IDs, all native results and
   the approved release-source commit on main. The qualified PR merge snapshot can differ from that
   commit only when their complete Git trees match. Keep original native build records; do not
   rewrite their source to the merge SHA.

A frozen main source can also be prepared with `gh workflow run cold-setup.yml --ref main` before
publish-go. Use this when the version PR's qualified merge snapshot no longer matches its main
merge. Main movement after the frozen source does not require another qualification.

Merging the version PR no longer publishes automatically. A push prepares versions; an explicit
publication dispatch promotes qualified bytes. Preparation and publication use separate queues, so
a build cannot hold the publish command behind it. Publication dispatches share one non-cancelling
queue and cannot overlap or evict one another.

Prepare a snapshot separately, before its publish command:

```bash
gh workflow run cold-setup.yml --ref main -f snapshot=next
```

The snapshot is versioned once before qualification. Publication replays those versions, including
their timestamp, rather than generating another version. Its qualification must name the same main
release-source commit. A changed candidate source or tree invalidates readiness. Later main merges
do not: the publisher uses the frozen source rather than silently widening the requested scope.

## Publishing the prepared candidate

On the human command, retain its original timestamp and dispatch the prepared main candidate:

```bash
gh workflow run changesets.yml --ref main \
  -f "version=<qualified-version>" \
  -f "qualification_run=<run-id>" \
  -f "candidate_sha256=<manifest-sha256>" \
  -f "source=<approved-main-sha>" \
  -f "requested_at=<original-UTC-timestamp>"
```

For a prepared snapshot, also pass `-f snapshot=next`, matching its qualification. A timestamp such
as `2026-10-22T09:15:00Z` is UTC. Do not replace the original command time with the dispatch time.

GitHub records the version, candidate digest, source, qualification run, tag and original UTC in the
dispatch name. Publication enumerates complete main-dispatch history, partitioning capped searches,
and binds later attempts to the earliest workflow run number for that version. A fresh dispatch
cannot replace its clock or requested scope. Keep those records; deleting history is not recovery.
The first human timestamp is still the maintainer's assertion. CI does not independently observe
the human command or make that history resistant to repository administrators.

The trusted publisher controls come from the dispatch's main commit. The requested release source
must be that commit or an older first-parent main commit. An owned temporary detached worktree
provides its manifests without a second clone or build. A merged side-branch head is not accepted
as a main version carrier. Qualification must match the frozen source's full tree, not the newer
publisher controls' tree. All three source identities are retained in the outcome.

The publisher checks the live GitHub run and immutable artifact selection. It rejects forks,
foreign repositories and workflows, failed or unfinished runs, partial reruns, expired or ambiguous
artifacts, qualification completed after the command, a changed candidate digest and a different
source tree. A PR run's API head is checked against the qualified merge snapshot's head parent;
it is not relabelled as the checkout. All 18 native receipts retain their original source and
candidate hash.

The candidate build attests its manifest through a pinned first-party GitHub action. Its public
Sigstore bundle binds the manifest to certificate claims about the source commit, signer workflow
commit and path, hosted runner, run ID and attempt. Promotion verifies those claims through `gh`
and reads invocation identity from the verified certificate. Predicate fields and a claimed Git
parent relationship cannot establish the executed source. Native qualification still requires all
18 receipts and a successful complete run. Forks retain native checks but cannot publish.

Preparation exercises the live certificate verifier with positive and wrong-source/run/attempt
controls before native qualification. The runner needs a `gh` version supporting artifact-attestation
verification and its source, signer and hosted-runner policy flags. Old unsigned qualifications are
ineligible; prepare a signed v2 candidate before the command.

The privileged workflow downloads by artifact ID and qualifying run ID with `actions: read`.
It does not rebuild packages, assemble different native binaries or run package hooks after go.
npm's provenance identifies the publication job. The qualification receipt separately identifies
the original build; same-tree promotion does not claim a new build at the merge SHA.

## Publication controls

The candidate packs every public package. Before packing it assembles native binaries, builds,
runs the package-shape probe and runs every public `prepublishOnly` guard in dependency order.
Packing runs pack hooks and hashes archive entries without extracting them.

Native setups install that archive set into empty homes, config and caches on Linux, macOS and
Windows, x64 and arm64, with Node 22, 24 and 26. They check installed bytes, connector seeding and two
broker, delivery and Manager lifecycles. Required evidence includes native process pins, control,
one-shot shutdown, cleanup and fresh process generations after restart. Missing evidence blocks
qualification. The final `cold-qualified` artifact is written only after all prerequisites succeed.

`ci:publish` runs `scripts/publish-cold-candidate.mjs`. Before the first write it checks:

- The complete public workspace census matches the Changesets fixed group.
- Every exact version is absent and every npm package record exists. Mixed or unknown results refuse.
- The requested dist-tag does not already point to a newer version of any package. Stale prepared
  candidates and unreadable tag metadata refuse before authorization, rather than moving a tag back.
- Every package has a successful package-specific GitHub OIDC exchange.
- A readable trusted-publisher document grants direct publication to this repository's
  `changesets.yml` publisher in `npm-publish`. A stage-only or foreign publisher refuses. npm's trust
  endpoint can return 401 because it requires an npm access token; that is recorded as unverifiable,
  not proof of a direct-publish permission. Other non-200 answers refuse.
- Every source manifest, archive path and archive hash matches qualification. Hashes are checked
  again at each write boundary.

Registry and authorization reads use bounded parallel work. At most four archive uploads run at
once. `cotal-ai` starts only after all sibling uploads succeed. Each upload uses:

```bash
pnpm publish <archive> --provenance --access=public --no-git-checks --ignore-scripts --tag <tag>
```

The tag is `latest` or the qualified snapshot tag. Package scripts already ran during preparation.
The publisher runs on the POSIX GitHub runner. A live supervisor keeps ownership of each client's
process group until client completion. The owner then terminates and observes that group, including
same-group descendants whose wrapper exited with ignored stdio. Its original deadline also stops
the group. It admits no new work after an error and waits for admitted groups to settle. Unobserved
settlement prevents further admission and leaves installation scratch in place for investigation. Receipts distinguish not-started,
running, accepted, refused and unknown outcomes. Accepted means the publisher client completed,
not that consumers can install the version. An interrupted running outcome requires investigation.

pnpm batch publishing is not used. It requires a registry-specific endpoint and shared credential,
and rejects the provenance path used here.

## Verifying availability

Before announcing a release, the workflow downloads every registry archive, compares its SHA-256
with the qualified bytes, checks its registry SHA-512 integrity and verifies every requested
dist-tag. It then installs `cotal-ai@<version>` into a fresh private home, config and cache and runs
`cotal --version`. Its environment excludes operator credentials and personal state. Upload and
install commands own their child groups and wait for closure before scratch cleanup. Normal
cancellation stops those groups and prevents new admissions. All stages share the original
ten-minute deadline, including the install check.

The normal release retains the full-closure metadata gate. Its `UNSETTLED` and `NONE` outcomes do not
create a GitHub Release. The overall publication outcome still fails unless actual archive and
install verification completed inside the original deadline. Accepted uploads alone cannot pass it.
Publication outcomes and immutable artifact identities are uploaded even on failure when the runner
can finish cleanup.

After successful verification, the normal release creates its GitHub tag and Release. It targets
the oldest first-parent main commit whose `bin/package.json` carries that version, including a
version reverted and later carried again. Unreadable history or a missing carrier refuses the tag.
Snapshot publication does not create that normal-release announcement.

## Recovering late registry visibility

Do not blindly repeat an upload, reset the command timestamp or start another native matrix.
The publication workflow refuses write attempts on a rerun; a fresh dispatch is not permission to
ignore unknown outcomes either. Retain the qualified candidate and publication outcomes. Recheck
registry metadata without writing:

```bash
node scripts/verify-publish-closure.mjs <version> --recheck
node scripts/verify-release-installable.mjs <version>
```

Recheck the retained archive set and dist-tag against the original request:

```bash
node scripts/verify-promoted-archives.mjs "<candidate>/manifest.json" latest "<output>.json" \
  --recheck "--requested-at=<original-UTC-timestamp>" "--candidate-sha256=<manifest-sha256>"
```

Use the qualified tag instead of `latest` for a snapshot. This read-only mode has a bounded recovery
observation window while preserving the original command time and candidate digest. Its receipt
reports late availability as outside the publication budget. Recovery never turns a missed deadline
into a timely release. If packages remain missing, inspect the write outcomes and registry evidence
before deciding on another write. Once availability is verified, the publication owner can finish a
missing announcement under the original release authorization.

## Correcting a released changelog entry

Add a `**Correction:**` paragraph under the existing bullet in every affected `CHANGELOG.md`, indented
two spaces. Preserve the original published text. Use identical correction wording so
`scripts/release-notes-detail.mjs` can deduplicate it.

## 0.11 runtime migration

The binary no longer bundles optional tmux and cmux runtimes. Existing operators run
`cotal ext add <runtime-package>` once before using that runtime. Missing runtimes fail with their
installation command instead of falling back to pty.
