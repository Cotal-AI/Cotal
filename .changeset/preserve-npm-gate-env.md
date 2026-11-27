---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Updates started directly by `node` preserve `npm_config_*` environment variables whose names are not shell identifiers, including registry bearer tokens, scoped registries, proxy settings and TLS flags, across the POSIX process-group gate when `/bin/sh` is `dash`. On Linux hosts where `/bin/sh` is `dash`, the `cotal` launcher script still drops those names before Cotal runs.
