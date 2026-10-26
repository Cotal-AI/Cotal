---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up` on a root with no prepared record and no stack journal starts on the legacy launcher whatever it names, including a root whose space its `up` registered. Before, such a root took the controller route when the invocation named no legacy-only option. On a stopped legacy user-auth root that started a controller broker beside the root's retained auth-service record, failed its auth member (`OPERATION_PARTIAL`), and wrote a stack journal that tied the root to the controller from then on. Only a root prepared here, or one whose stack journal exists, takes the controller route.
