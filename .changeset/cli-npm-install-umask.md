---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Start every npm child of `cotal update`, `cotal ext add` and setup's global install with 022 added to the process umask, and create a missing extension prefix with mode 0755 and its package.json with mode 0644. Under a umask of 0002, npm made group-writable directories, files and bin targets, and its own `--umask` setting still left package directories and bin targets group-writable. A stricter umask keeps its bits, and the previous umask is restored as soon as each spawn call returns.
