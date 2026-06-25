# Release and publish

Cotal uses [Changesets](https://github.com/changesets/changesets) to version and publish the
workspace packages under `packages/*`, `extensions/*`, and `implementations/*` to npm.
`examples/**` is ignored, since it is not published.

## One-time npm setup: trusted publishing (OIDC)

Trusted publishing replaces the long-lived `NPM_TOKEN` secret with short-lived OIDC tokens
issued by GitHub Actions. Each published package must be configured once on npmjs.com.

For **every** published package (`@cotal-ai/core`, `@cotal-ai/cli`, `@cotal-ai/manager`,
`@cotal-ai/delivery`, `@cotal-ai/connector-core`, `@cotal-ai/connector-claude-code`,
`@cotal-ai/connector-opencode`, `@cotal-ai/connector-hermes`, `@cotal-ai/cmux`, and the
`cotal-ai` binary):

1. Go to `https://www.npmjs.com/package/<name>/access` (e.g.
   `https://www.npmjs.com/package/@cotal-ai/core/access`).
2. Scroll to **Trusted publishing** → **Add a trusted publisher**.
3. Pick **GitHub Actions**.
4. Fill in:
   - **Organization or user:** the GitHub owner (your org or user).
   - **Repository:** `SWARL` (or whatever this repo is called).
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

## How `ci:publish` is wired

`ci:publish` in the root `package.json` is:

```bash
pnpm publish -r --provenance --access=public --no-git-checks
```

- `-r`: recursively publish all workspace packages.
- `--provenance`: emit SLSA provenance attestations (a no-op without OIDC, automatic with it).
- `--access=public`: required for scoped packages on first publish.
- `--no-git-checks`: skip pnpm's branch / clean-tree guard, since CI does not need it.
