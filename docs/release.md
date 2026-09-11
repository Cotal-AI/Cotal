# Publishing a release

> **Project** (non-normative maintainer notes) · **For:** maintainers shipping Cotal

Cotal uses [Changesets](https://github.com/changesets/changesets) to version and publish the
workspace packages under `packages/*`, `extensions/*`, and `implementations/*` to npm.
`examples/**` is ignored, since it is not published.

## 0.11 runtime migration

The published binary no longer bundles the optional tmux and cmux runtimes. Existing operators
must run `cotal ext add @cotal-ai/tmux` or `cotal ext add @cotal-ai/cmux` once after upgrading,
before using `runtime: tmux|cmux` in a manifest or passing `--runtime tmux|cmux`. Missing runtimes
fail loudly with the matching install command; they never fall back to pty.

## Trusted publishing

Trusted publishing replaces the long-lived `NPM_TOKEN` secret with short-lived OIDC tokens
issued by GitHub Actions. Each published package must be configured once on npmjs.com.

The `fixed` group in [`.changeset/config.json`](../.changeset/config.json) is the list that
gets versioned and published. Derive the package list from it instead of
maintaining it by hand. It had drifted by six packages before this was last reconciled.

For **every** published package, `cotal-ai` (the binary), `@cotal-ai/core`,
`@cotal-ai/workspace`, `@cotal-ai/cli`, `@cotal-ai/manager`, `@cotal-ai/delivery`,
`@cotal-ai/web`, `@cotal-ai/cmux`, `@cotal-ai/orca`, `@cotal-ai/tmux`, `@cotal-ai/herdr`,
`@cotal-ai/connector-core`, `@cotal-ai/connector-claude-code`, `@cotal-ai/connector-hermes`,
`@cotal-ai/connector-opencode`, `@cotal-ai/connector-codex`, `@cotal-ai/pi`, `@cotal-ai/auth`:

1. Go to `https://www.npmjs.com/package/<name>/access` (e.g.
   `https://www.npmjs.com/package/@cotal-ai/core/access`).
2. Scroll to **Trusted publishing** → **Add a trusted publisher**.
3. Pick **GitHub Actions**.
4. Fill in:
   - **Organization or user:** the GitHub owner (your org or user).
   - **Repository:** `Cotal`.
   - **Workflow filename:** `changesets.yml`.
   - **Environment name:** leave blank.
5. Save. Repeat for every package.

> The first time, you may need to publish a version manually (with a classic token) so the
> package exists on npm. After that, OIDC takes over.

## Day-to-day flow

1. Open a PR that changes code in a publishable package.
2. Add a changeset describing the change:

   ```bash
   pnpm changeset
   ```

   Pick the affected packages plus the semver bump (patch / minor / major), and write a
   one-line summary. Commit the generated `.changeset/<name>.md` file alongside your code
   change.
3. Merge to `main`.
4. The `Changesets` workflow runs:
   - If there are pending changesets, it opens (or updates) a PR titled `chore(release):
     version packages` that bumps versions and updates `CHANGELOG.md` files.
   - When **that** PR is merged, the same workflow detects the bumped versions, runs `pnpm
     build`, and `pnpm publish`es each changed package to npm with provenance.

## Manual publish (escape hatch)

If the workflow is broken, you can run the same steps locally with a classic npm token:

```bash
pnpm ci:version
pnpm ci:publish
```

Set `NPM_TOKEN` in your environment first. **Do not** commit the token.

## Publication workflow

`ci:publish` in the root `package.json` is:

- an exact-version census of every package in the Changesets fixed group against the registry;
- a check that the public recursive workspace set is exactly that fixed group;
- one GitHub OIDC exchange per package when the release job exposes the OIDC requester;
- only after those checks, the workspace build, native assembly, and recursive publish.

The census prints every package and version before it refuses. If any exact version already exists,
or the recursive publish set is not the full fixed group, the command exits before `pnpm publish`.

pnpm's `--batch` option was evaluated. It exists from pnpm 11.7 and is all-or-nothing only on a
registry implementing `PUT /-/pnpm/v1/publish` (pnpr does). npm's registry returns 404 for read-only
`GET` and `OPTIONS` probes of that endpoint, and its published Registry API does not document it.
pnpm batch publishing also rejects provenance and requires one shared credential for the batch
instead of the per-package OIDC exchanges used here. The repository stays on the normal npm publish
protocol and treats the preflight as the fail-before-first-write control.

```bash
node scripts/preflight-npm-publish.mjs && pnpm build && node scripts/seat-assemble-natives.mjs && pnpm publish -r --provenance --access=public --no-git-checks
```

- `preflight-npm-publish.mjs`: derive and print the full fixed-group package/version census. In
  GitHub Actions it also verifies a package-specific OIDC exchange for every package. A manual run
  with `NPM_TOKEN` still gets the registry and closure census; npm verifies that token on publish.
- `pnpm build`: build every workspace package first, supplying local workspace dependency outputs
  when a partial retry publishes only the packages still missing.
- `seat-assemble-natives.mjs`: assemble the downloaded native seat artifacts before publication.
- Seat's pack and publish hooks assert both native artifacts and compile its JavaScript and type
  entrypoints without rebuilding the native helpers.
- `-r`: recursively publish all workspace packages.
- `--provenance`: emit SLSA provenance attestations (a no-op without OIDC, automatic with it).
- `--access=public`: required for scoped packages on first publish.
- `--no-git-checks`: skip pnpm's branch / clean-tree guard, since CI does not need it.
