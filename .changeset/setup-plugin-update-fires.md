---
"@cotal-ai/cli": patch
---

Fix `cotal setup` failing on every upgrade with `plugin <name>@cotal-mesh is at version <old>,
expected <new> (the update did not take)`. `installOrUpdatePlugin` ran `claude plugin update`
only inside the install-failed branch, but `claude plugin install` reports "is already
installed" and exits **zero**, so on an upgrade the update never fired, the Claude plugin cache
kept the old version, and the verification step then threw. The update is now triggered by what
`plugin install` reports rather than by an exit status that never comes, which is what closes
the upgrade path for the `cotal` connector plugin and the `cotal-skills` plugin alike.

Also correct setup's own Node preflight, which still checked for Node 20 and told the user
"Cotal needs Node 20 or newer" while `cotal-ai` declares and enforces a Node 22 floor.
