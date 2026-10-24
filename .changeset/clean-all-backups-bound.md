---
"@cotal-ai/cli": patch
---

`clean all` now says when it removes a space's trust that the full backups taken before it no longer
restore into the root, in its dry run and in its receipt. A full backup is bound to the trust it was
taken under, and nothing said so before the clean; only `up --rotate-sys` was documented. The docs
now say so for `clean all`, say that `backup inspect` and `backup verify` do not check an artifact's
trust against the root, and say that a registry restore, `--only registry` included, does not check
the trust state.
