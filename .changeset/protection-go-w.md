---
"@cotal-ai/workspace": patch
---

The refusal for a folder or file other local accounts can write now names one step when the path is writable by its group and by every account: `chmod go-w <path>`. It used to name `chmod o-w`, and on a host where the group could not be proven private the next run refused again with `chmod g-w`. The other group and world gaps in the same refusal join that one command. `auth mint --out`, a `--creds` read and every other command that checks a path for other local writers share this refusal.
