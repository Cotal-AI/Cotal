---
"@cotal-ai/cli": patch
"@cotal-ai/connector-jcode": patch
---

A foreground `cotal spawn` on an open mesh now gives an event-armed seat a stable actor, its seat name, before the connector builds the launch. Before, every connector except Jcode launched with no identity, so the seat ran its turn and its AG-UI emitter then stopped at the first publish with a self-minted-identity error and no event reached the broker. The Jcode connector no longer carries its own copy of the rule.
