---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

The language version belongs to the engine that runs a program, and a build declares which engines it hosts.

There are two engines and now two versions: the tree-walker is language version `1` and stays the
replay engine for every run recorded under it, and the compiled engine is version `2`, a different
language rather than a faster one, since `log` is data there and refuses code, and a step is a
transformed-site hit rather than a walker dispatch. `resolvePins` and `bindPins` take the version as
an argument, so each engine stamps its own and compares against its own; `WALKER_LANGUAGE_VERSION`
and `ENGINE_LANGUAGE_VERSION` are exported beside `LANGUAGE_VERSION`, which is an alias for the
current language, the engine's.

Bumping one shared constant was measured and is not available: the walker would stamp 2 and compare
1, and every walker fresh-run-then-resume round trip fails. Leaving it at 1 while the engine speaks
2 fails the other way, on records already written. Each engine stamping and comparing its own breaks
neither.

The run driver now holds a table of the versions this build hosts, ordered by declared precedence
rather than by a string sort. A fresh run is stamped with the version of the engine that will
actually execute it (today that is `1`, the walker, because no driver hosts the version-2 engine
yet), and a record whose version no engine here serves is released by name with the new **L5023**,
naming both the version it met and the set this build serves, with the run left untouched: nothing
activated and nothing appended. It is released rather than failed or thrown, because a build that
cannot host a language has observed nothing about the program.

Migration: `resolvePins(options, now)` and `bindPins(recorded, options)` now require a third
argument, the calling engine's version. Callers inside this repo pass their own; an external caller
passes `WALKER_LANGUAGE_VERSION` to keep today's behaviour. Records do not cross between versions in
either direction, which was already true and is now enforced by the engine that meets them.
