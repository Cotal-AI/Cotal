---
"@cotal-ai/cli": patch
---

`backup inspect` and `backup verify` of a file, or of a folder that holds neither a manifest nor any
file a backup create writes, now refuse `TARGET_NOT_FOUND` and say it is not a backup artifact. Such
a folder was called an interrupted backup and pointed to an attempt and a recovery that did not
exist. The empty folder of a create in this root that was interrupted before it wrote a file is still
named as its incomplete artifact.
