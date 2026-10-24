---
"@cotal-ai/cli": patch
---

`cotal up` now answers every `--host` refusal as a `USAGE_INVALID` report, so `--json` gets its envelope instead of a bare error line. A `--server` naming an IPv4 address other than `127.0.0.1` with no `--host` is refused before anything starts, and its next step names the `--host` to add; the broker used to bind `127.0.0.1`, exit 3 and record the address. A stopped stack whose broker bind does not serve its recorded address, as an earlier version could leave behind, now refuses `up` with `CONFLICT` and names `cotal up --host <host>`, which replaces the recorded bind host.
