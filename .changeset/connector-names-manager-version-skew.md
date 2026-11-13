---
"@cotal-ai/connector-core": patch
---

A manager-op tool refused by a manager on an older release now explains why. Before, `cotal_persona` or `cotal_spawn` sent to an older manager returned only the raw schema error, `must NOT have additional properties`. The refusal now names the argument that manager does not take and this connector's version, and asks the bound manager for its version. When the manager is older, it names `cotal update --self` on the manager's host and then `cotal manager restart`, or calling again without that argument. When the connector is older, it names `cotal update --self` here and a new session.
