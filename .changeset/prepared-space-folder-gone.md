---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A selected prepared space whose project folder was deleted now says the folder no longer exists and
names `cotal space forget <space>`. Before, `use`, `status`, `ps` and `up --space` said to start it
with `cotal up` in the missing folder, `persona` refused with no path or remedy, and `space forget`
said the files under that folder were kept.
