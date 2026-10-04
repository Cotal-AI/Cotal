---
---

`seat-env-scope` now checks every `COTAL_` name a connector's `buildLaunch` emits against the names the `operator-env-keep` census parses from source, and fails on any name the census cannot see. That launch is built with every keep-listed name removed from the runner's environment, so no emitted name is excused as inherited, whatever values the runner carries. The census learns assignment spellings one at a time, so a spelling it missed used to leave its "0 conflicts" result green for a name it never read. The parser now lives in a shared smoke helper so both suites read the same set. Paths that no `buildLaunch` call drives are still covered by the parser alone.
