---
"@cotal-ai/cli": patch
---

Daemons now run under the Node flag `--max-semi-space-size=1`, which caps V8's young generation at 2 MB. `cotal up` puts it on the manager, delivery daemon and user-auth service it starts. `cotal service start` puts it on every service it launches through the CLI, and the unit `cotal service install` writes carries it too, as does the container entry in `deploy/docker`. On a stack with no seats, 30 seconds and 5 minutes after `cotal up` (the mean of two runs each), the manager went from 268 MB to 147 MB of private memory in its first minutes and from 126 MB to 111 MB once settled. The delivery daemon went from 174 MB to 108 MB, then from 118 MB to 105 MB. The user-auth service went from 254 MB to 112 MB, then from 153 MB to 105 MB. Nothing else changes. A unit an earlier release wrote keeps its own command line.
