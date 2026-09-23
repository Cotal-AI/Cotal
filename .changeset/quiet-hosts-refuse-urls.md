---
"@cotal-ai/cli": patch
---

Refuse a URL or `host:port` value passed to `cotal up --host` by name, pointing at `--server`, instead of bracketing it into an unparseable broker URL. With no `--server` the derived garbage string used to reach the registry comparison and misfire as the unrelated "registered by hand" refusal; with `--server` the mismatch check threw a raw `Invalid URL` instead of its own diagnostic. The manifest path gets the same refusal for `broker.host` against `broker.servers`. (issue #1697)
