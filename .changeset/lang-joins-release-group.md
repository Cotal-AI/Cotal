---
"@cotal-ai/lang": minor
---

Version `@cotal-ai/lang` with the rest of the workspace. It is a public package (`packages/lang`, alongside `core` and `workspace`) but was missing from the `fixed` group, so Changesets never bumped it: it stayed pinned at 0.15.0 while every other package moved, and `pnpm publish -r` would have pushed a version permanently out of lockstep with the release it shipped in. Joining the group means it versions and publishes with everything else.
