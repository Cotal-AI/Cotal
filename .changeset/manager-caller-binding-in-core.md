---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

The check that a minted `manager-caller` bearer is bound to the caller and names one manager instance now lives in one `@cotal-ai/core` function, `managerCallerBinding`, which `userViewAuth` in `@cotal-ai/workspace` and the connector's manager calls both use. Before, each package kept its own copy and they had drifted: the CLI accepted a bearer with two or four segments that the connector refused, and the two gave different refusals for an undecodable bearer, a bearer with no `act.managerInstanceId` and a bearer with no `act.lifecycleUid`. Both now refuse those bearers with the connector's sentences.
