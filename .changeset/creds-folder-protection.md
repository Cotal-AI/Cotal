---
"@cotal-ai/workspace": patch
---

A `--creds` file in a folder another local account can write, or below one, is now refused `PERMISSION_DENIED` before it is read, as `auth mint` refuses to write a credential there. The refusal names the folder, and its next step is the `chmod`. Until now every command that reads `--creds` used such a file silently.
