---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal doctor auth --space <space>` run outside that space's root still refuses `AUTH_REQUIRED`
and reads no other root, and now names the folder the space is registered at, where the same
command runs. The `NOTHING_REPLACED` warning of `cotal auth mint --replace` names that root too.
Before, the warning sent users to `doctor auth --space <space>` from any folder, and the refusal
that came named no next step.
