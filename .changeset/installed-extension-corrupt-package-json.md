---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

An installed extension whose `package.json` is not JSON or has no `version` is no longer reported as not installed or with a bare JSON parse error. `installedExtensionVersion` throws `CorruptExtensionPackageError`, which names the package and its `package.json`, so loading the extension, `cotal status` and the `cotal setup` card report the damaged file. `cotal ext seed --repair` reinstalls a seeded built-in in that state, including after a corrupt extensions manifest was rebuilt.
