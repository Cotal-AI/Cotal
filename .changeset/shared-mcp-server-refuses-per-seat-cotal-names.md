---
"@cotal-ai/connector-core": minor
---

A shared MCP server in the cotal config now refuses a `${VAR}` reference to a `COTAL_` name the launcher sets for each seat, such as `${COTAL_ROLE}` or `${COTAL_MODEL}`, and the spawn fails before launch with an error naming the reference. Before, the reference forwarded the spawning process's value, and a seat launched with no role or model of its own read it as its role or model pin. This applies the rule `spawn.env` already follows: references to the machine-wide knobs such as `${COTAL_HOME}` and to names outside the `COTAL_` namespace forward as before.
