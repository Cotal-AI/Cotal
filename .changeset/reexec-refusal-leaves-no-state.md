---
"@cotal-ai/cli": patch
---

A refused re-exec no longer leaves a pid record, a daemon log or a seed journal entry behind, and
the entry check no longer trusts a file name

The entry check in `selfArgv()` accepted any file named `cotal`, `cotal.ts` or `cotal.js`, so an
unrelated file with one of those names could still re-exec itself as a daemon. The entry now counts
only when it resolves, through any symlink, to the bin that the `cotal-ai` package declares
(`dist/cotal.js`) or to the `cotal.ts` beside that package's manifest (a checkout's
`bin/cotal.ts`). A global install's `bin/cotal` symlink resolves into the package and is still
accepted.

Four paths ran the check only after they had changed something, and now run it first:

- The auth-service starter published its pid slot, already naming the launcher, before the check.
  A refused start left a record that read as a running service, so a retry started nothing, and
  teardown would signal whichever process held the launcher's pid.
- The connector seed wrote its crash cursor, staged the payload and wrote a pending child marker
  before the check. The next command then failed with "a connector seed may be mid-flight", and
  `cotal ext seed --repair` refused the same way until the marker was removed by hand.
- The manager and delivery starters deleted dead pre-upgrade records (their pidfiles and the
  delivery-aware marker) before the check.

The refusal's remedy line now names `ensureAuthService` along with the other starters.
