---
"@cotal-ai/cli": patch
---

`cotal up -f` now refuses a `broker.servers` or `--server` that lists more than one URL, naming which of the two lists them and saying that `up -f` binds a single broker address, and `cotal team boot` refuses such a `broker.servers` the same way. Each entry still passes the usual URL and credential checks first. Such a manifest used to fail with a bare `Invalid URL` and an unknown outcome. The manifest still validates with a list, and `topology view` still shows it.
