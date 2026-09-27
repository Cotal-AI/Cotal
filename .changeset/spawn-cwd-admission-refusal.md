---
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

`spawn` refuses at admission a `cwd` the serving manager's host cannot resolve, naming the path, the reason and the host, so a misplaced spawn in a multi-manager space fails before anything is minted instead of at launch (#385 item 2). `cotal_spawn` documents that an unresolvable `cwd` is refused before launch.
