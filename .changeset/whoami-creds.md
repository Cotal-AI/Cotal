---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal whoami --creds <file>` reports what a credential file may do: the space its permissions
name, its profile, principal and agent lifecycle, when it was issued and when it expires, the
channels it may read and post to, and whether it may read every DM, only its own, or none. It
decodes the file's own claims and contacts no broker. No command showed this before: `whoami` had
no `--creds`, and `auth handle inspect` refuses a credential file, whose Next now names
`whoami --creds`.
