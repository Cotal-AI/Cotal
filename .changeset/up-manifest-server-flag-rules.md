---
"@cotal-ai/cli": patch
---

`cotal up -f` and `cotal spawn -f` now check `--server` against the rules a manifest's `broker.servers` already follows. A `--server` URL with embedded credentials used to pass: `up -f --dry-run` printed it whole in the plan, and `spawn -f` dialed it and printed it in its reach error. It is now refused with `--server entry 1 must not embed credentials`, a message that does not repeat the value. An invalid `--server` URL is refused the same way, and so is a value that names no URL: `--server ""` used to fall back to the default broker, and a blank or comma-only `--server` or `broker.servers` failed with a bare `Invalid URL`. Both now get `names no server URL`.
