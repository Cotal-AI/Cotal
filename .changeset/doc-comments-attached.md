---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/core": patch
"@cotal-ai/lang": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
"@cotal-ai/web": patch
"@cotal-ai/workspace": patch
---

Re-attach doc comments that had drifted away from the declarations they document. A `/** */` block followed directly by another one documented nothing, so editor hovers and the published type declarations showed no doc for the intended declaration (for example `Manager`, the `plane3` field and `AclResolver`). Each such block now sits above its declaration, is merged into the block it duplicated, or is removed when its declaration no longer exists. A new `pnpm check:doc-comments` check, run as part of `check:docsbundle`, refuses a doc block followed directly by another in shipped source.
