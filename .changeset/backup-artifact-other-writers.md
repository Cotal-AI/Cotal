---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`backup verify`, `backup restore` and `up --restore` refuse an artifact that another local account
could write. A copy whose folder and files were group-writable verified and restored without a
word, although its hashes cannot show a consistent rewrite. The artifact directory, each file in it
and each directory above it now follow the protected-path rule `space create` applies to a project
root: an unsafe one refuses `PERMISSION_DENIED` (exit 2) before a restore stages or changes
anything, naming every such path and one remedy such as `chmod g-w <paths>`.
