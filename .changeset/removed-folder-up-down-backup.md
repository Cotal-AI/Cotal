---
"@cotal-ai/cli": patch
---

`up`, `down` and `backup create` run from a folder that no longer exists crashed with Node's `process.cwd` stack trace, while other commands refused. They now refuse the same way, `USAGE_INVALID`, exit 1, saying to `cd` to an existing folder, before their own checks run.
