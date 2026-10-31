---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Let `cotal ext seed --reset` and `--repair` finish when the extensions manifest records a package whose directory is gone, such as one npm pruned as extraneous. `ext add`, `ext remove` and each seed now warn with the package, its path, the command that reinstalls it and `cotal ext remove <package>`, and keep its manifest entry. For a third-party package that command is `cotal ext add <original-spec>` with the placeholder left in, so the warning does not print a recorded spec that may be a URL carrying a credential. They no longer fail on it. A package directory without a readable `package.json`, a dangling package link and a corrupt `package.json` still fail. A seed that failed this way in an earlier release is finished by `cotal ext seed --repair`, after which `cotal ext remove` drops the entry.
