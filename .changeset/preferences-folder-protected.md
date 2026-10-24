---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A preferences folder that another local account could write is no longer trusted silently. It
follows the protected-path rule `space create` applies to a project root. Every command that uses
the saved preferences still applies them, with a `PREFERENCES_FOLDER_UNPROTECTED` warning naming
the folder and the `chmod` that fixes it, and `cotal status` lists that `chmod` under Next.
`config set` and `unset`, `setup` and the preference removal in `space forget` refuse such a folder
with `PERMISSION_DENIED` (exit 2) before anything is written.
