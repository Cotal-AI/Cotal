---
"@cotal-ai/cli": patch
---

A re-exec the CLI refuses now leaves the root and the seed store as it found them, and the entry
check no longer trusts a file name

The entry check in `selfArgv()` accepted any file named `cotal`, `cotal.ts` or `cotal.js`, so an
unrelated file with one of those names could still re-exec itself as a daemon. The entry now counts
only when it resolves, through any symlink, to the bin that the `cotal-ai` package declares
(`dist/cotal.js`) or to the `cotal.ts` beside that package's manifest (a checkout's
`bin/cotal.ts`). A global install's `bin/cotal` symlink resolves into the package and is still
accepted.

Four paths ran the check only after they had changed something, and now run it first:

- The auth-service starter published its pid slot, already naming the launcher, before the check.
  A refused start left a record that read as a running service, so a retry started nothing, and
  teardown signalled whichever process held the launcher's pid.
- The connector seed wrote its crash cursor, staged the payload and wrote a pending child marker
  before the check. The next command then failed with "a connector seed may be mid-flight" until
  `cotal ext seed --repair`.
- The manager and delivery starters deleted dead pre-upgrade pidfiles before the check.

The refusal's remedy line now names `ensureAuthService` along with the other starters.
