---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Running `cotal update --self` preserves `npm_config_*` environment variables whose names are not shell identifiers, including registry bearer tokens, scoped registries, proxy settings and TLS flags, when `/bin/sh` is `dash`.
