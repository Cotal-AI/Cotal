---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Show the identity provider's reason when it refuses an elevated view. On a user-auth mesh, `history clear` without scope `admin` and a legacy `team remove --dry-run` whose deployer view is refused still fail with `PERMISSION_DENIED`, and their remedy is now the provider's sentence: the view, the scope the grant lacks and the whole-row re-grant that adds it.
