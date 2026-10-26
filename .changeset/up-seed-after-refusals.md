---
"@cotal-ai/cli": patch
---

A refused `cotal up` no longer moves the operator-global connector seed store. `up` reconciled that store at the boot gate, before its own checks, so an `up` that then refused (a folder named after a space another folder holds, a `--channels` file that is not JSON) had already stamped the store with its generation while saying nothing was written, and an older `cotal` then refused the store as a downgrade. `up` now seeds when it first starts a process, or when `up -f` checks its agents' connectors, and a start that fails after the seed moved the store says so and names it. An older `cotal` still refuses a newer store before writing anything; its refusal now names the store and the extensions folder and says to restore both from a backup taken before the store moved, with the versions as context.
