---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A manager's endpoint reply now becomes a `ControlReply` through one core function, `controlReplyFrom`, which `cotal spawn -f`, the CLI's other manager calls (`cotal spawn --detach`, `stop`, `attach` and the rest) and `cotal_spawn` all use. Before, each caller copied the conversion and kept different fields. `cotal spawn -f` dropped the error code, the lifecycle-blocked details and their rendered `[lifecycle …]` facts, and the acceptance an uncertain launch keeps, so it could tell an `uncertain` launch from a `failed` one only by its text. `cotal spawn --detach` dropped that acceptance too, and a `stop` or `attach` whose name lookup was refused dropped the rendered facts. A refusal now carries the same code, details, facts and data whichever caller it reaches.
