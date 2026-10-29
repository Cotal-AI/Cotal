---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Make the broker preset's `--log-file` a declared file path: help shows `<file>`, a relative path is refused at add as the other path options are, and its description no longer says only `cotal up` prepares it. A preset add's missing-option refusal and bare `service` now also name `--server <url>` when the space has no registered broker, so the printed line works as given. A schema or path refusal on a preset add names the flag typed, such as `--log-file`, instead of the adapter's option key, and a schema refusal gives the preset's `--help` as its Next. `service show` and `service remove` now resolve a preset name to the space's one service built on that preset, as the other service verbs do.
