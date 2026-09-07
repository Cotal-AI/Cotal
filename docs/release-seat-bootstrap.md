# One-time `@cotal-ai/seat` bootstrap

This runbook is for npm and repository owners recovering release `0.47.0`. It is temporary. Do not use it for another package or version.

The Changesets run `34072874048` published `@cotal-ai/lang@0.47.0`, then stopped because npm trusted publishing cannot create the missing `@cotal-ai/seat` package. The bootstrap workflow publishes only the tarball already built and tested by CI run `34072874022` from commit `609ce674235e32517a7d726585d2f736d629a77e`.

## Owner setup

1. Merge the workflow and this runbook to `main` with `[skip ci]` in the merge commit subject. The workflow itself pins the source artifact to CI run `34072874022` and release commit `609ce674`; adoption must not start the normal Changesets publisher.
2. On npmjs.com, create a granular access token with:
   - the shortest available expiration;
   - **Read and write** access to the `@cotal-ai` scope only;
   - no organization-management permission;
   - **Bypass 2FA** enabled for this initial publication only.

   Stop if npm does not offer scope-only package access. Do not grant all-package write access.
3. Identify a second repository owner who did not trigger the workflow and who will approve the protected environment. Stop if no such second approver is available.
4. In GitHub, create the `seat-bootstrap` environment. Allow deployments only from `main`, add that second owner as the required reviewer, enable prevent self-review, and disable administrator bypass.
5. Add the token as the environment secret `NPM_SEAT_BOOTSTRAP_TOKEN`. Do not create a repository or organization secret.

No token value belongs in a workflow input, command argument, file committed to git, issue, pull request, or Actions log.

## Owner publication

1. Open **Actions → Bootstrap @cotal-ai/seat → Run workflow** on `main`.
2. Enter `publish @cotal-ai/seat@0.47.0 from artifact 10001064028`.
3. Have the distinct second owner confirm that the pending deployment shows the `seat-bootstrap` environment, the expected workflow commit, and actor `davidfarah2003`, then approve it. The triggering owner must not approve their own run.
4. Wait for the workflow to verify the artifact and registry integrity. Do not rerun Changesets yet.

The workflow refuses any other repository, repository ID, actor, actor ID, event, ref, confirmation string, source run, source commit, artifact, package, version, zip digest, tarball digest, or existing mismatched registry version. The only step that receives the secret writes it to a temporary `0600` npm userconfig, runs one fixed `npm publish` command against that tarball with provenance, and removes the file on exit. The run is idempotent after the exact tarball is live.

## Clean up every attempt

Perform these steps in order after every run attempt, including failure or cancellation:

1. On npmjs.com, revoke the granular access token.
2. In GitHub, delete `NPM_SEAT_BOOTSTRAP_TOKEN` from the `seat-bootstrap` environment.

Query `https://registry.npmjs.org/%40cotal-ai%2fseat/0.47.0` after cleanup and handle the result as follows:

- `404`: the publish did not complete. Keep the environment and bootstrap files, then stop for diagnosis.
- `200` with `.version` equal to `0.47.0` and `.dist.integrity` equal to `sha512-2waXKc5uvZ+J4H8GzTQaokudZYJMb2pRnks7XikE4dyD5q2UTwmQIMER5qynD0nbmjrYhjmbKUYYV/PnmuUzPw==`: continue to the successful recovery steps.
- `200` with a parse failure, missing version or integrity, version mismatch, or integrity mismatch: keep the environment and bootstrap files, then stop for diagnosis.
- Any other HTTP status: keep the environment and bootstrap files, then stop for diagnosis. Do not continue recovery from an unknown or mismatched registry state.

For a retry, diagnose and fix the failed attempt, create a fresh token, replace the environment secret, and repeat the owner publication steps with the same distinct-owner approval requirement. Revoke and delete the replacement credentials after the retry too. Until the exact package is live, do not configure trusted publishing, delete the environment or bootstrap files, rerun Changesets, or verify the publish closure.

## Finish a successful recovery

1. On the new `@cotal-ai/seat` package, add the trusted publisher:
   - provider: **GitHub Actions**;
   - organization: `Cotal-AI`;
   - repository: `Cotal`;
   - workflow filename: `changesets.yml`;
   - environment: blank;
   - allowed actions: enable direct `npm publish`, matching the existing release workflow.
2. Delete the `seat-bootstrap` environment.
3. Remove `.github/workflows/bootstrap-seat.yml` and this runbook in a `[skip ci]` commit. Do not let either adoption or removal trigger Changesets.
4. Rerun failed Changesets run `34072874048`. Existing packages continue using their unchanged `changesets.yml` OIDC publishers.
5. Run `node scripts/verify-publish-closure.mjs 0.47.0` and require `PUBLISHED/22`. Do not accept or create the GitHub release before that result.

The initial `@cotal-ai/seat@0.47.0` publication uses a granular token for npm authentication. Its provenance identifies the emergency bootstrap workflow. The workflow's pinned IDs and digest checks are what bind the published bytes to the earlier CI artifact. Later versions use `changesets.yml` with token-free trusted publishing. Do not republish or bump the version to conceal the authentication exception.
