---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal ps` on a user-auth mesh with several of your managers live no longer refuses or asks which one. It reads each manager the exchange counts live through its own one-instance view and lists each under its own `manager <id>` header with the host its presence reports. A manager that does not answer is listed as silent and makes the read partial, as on a static mesh. `status <agent>`, `who` and the `attach` picker read your managers the same way. When none of your managers answers, or none is live, `ps` lists your agents as presence shows them, read-only, and exits 0. Its next step starts a manager: bare `cotal up` on the root of the space's own stack, `cotal supervise` anywhere else. `--json` reports that read as `result.kind` `presence`.
