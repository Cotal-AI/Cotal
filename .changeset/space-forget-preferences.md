---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal space forget` now removes the per-space preferences saved under the name it forgets, so a later space with the same name no longer inherits them. The receipt lists each removed key and value with the `config set` that restores one. The removal takes the preferences file's lock and revision check; when it fails after the record is gone, the run is partial and names the `config unset` that finishes it.
