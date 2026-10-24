---
"@cotal-ai/cli": patch
---

`cotal who --creds` with a manager on the roster is now a complete read that labels the managers `MANAGERS_DENIED`. A credential passed with `--creds` carries no caller the managers accept from this command, so they are not asked. It used to exit 4 as a partial read, with a `MANAGERS_UNREAD` warning that blamed the managers.
