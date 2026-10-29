---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Take the broker preset's `--log-file` as `cotal up --log-file` takes it: help shows `<path>`, `add` refuses an empty value or one with control characters and saves a relative path made absolute against the folder it runs in, the file need not exist yet, and its description no longer says only `cotal up` prepares it. A preset add's missing-option refusal and bare `service` now also name `--server <url>` when the space has no registered broker, so the printed line works as given. A schema or path refusal on a preset add names the flag typed, such as `--config`, instead of the adapter's option key, and a schema refusal gives the preset's `--help` as its Next. `service show` and `service remove` now resolve a preset name to the space's one service built on that preset, as the other service verbs do.
