---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

Resolve an agent's read list through one core function, `resolveReadAcl`, at every site: the persona loader, the session config, the manager launch, foreground `cotal spawn` and its user-mode grant, `cotal mint` and the manifest persona merge. An explicit empty `allowSubscribe` now reads `subscribe` everywhere, as an omitted one does. Before, the session refused a persona the loader had accepted. The manager also granted and recorded an empty read list while the provisioner recorded `subscribe`.
