---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A command interrupted by SIGINT, SIGTERM or SIGHUP while the CLI is still loading now says it did
nothing and exits 130, 143 or 129. It used to exit with no output, even for a `down` whose members
kept running. A detached `up` and a bare `down` now install their own notice before they take the
stack's lock, so an interrupt right after the lock is taken is reported too.
