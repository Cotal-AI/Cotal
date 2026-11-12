---
"cotal-ai": patch
"@cotal-ai/auth": patch
"@cotal-ai/workspace": patch
---

Signing in as a different account at the same provider now deletes the previous account's discovered-space credential files along with their registrations.
This applies to `cotal login` and to the default daemon's `cotal daemon login` and `setup`. Only the sentinel file each discovered registration kept in its catalog folder is deleted, and never one reached through a symbolic link below the account's catalog folder; manual registrations and their files stay. A file that cannot be deleted is named and the run exits 4 (`OPERATION_PARTIAL`) after signing in; `daemon login` JSON lists such files in `credentialsKept`, and the desktop app keeps the new sign-in while showing the same files and cleanup. A separate `--daemon-home` still never changes the shared registry or its credentials.
