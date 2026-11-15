---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---
Stage complete execution generations before switching the installed CLI during updates.

The updater checks the retained target before publication, keeps the original execution graph intact for running commands, refuses staged generation retention inside bundled desktop runtimes, normalizes execution identity paths with native realpaths across platforms, retires superseded active descriptors when an in-place global install takes over, and reports retained-generation provenance under `cotal status --verbose` and `--json`. Retained execution journals restore the previous selection without reinstalling the live package, while interrupted records from earlier releases keep their existing recovery path.
