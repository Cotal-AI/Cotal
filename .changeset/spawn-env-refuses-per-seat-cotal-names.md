---
"@cotal-ai/connector-core": minor
---

`spawn.env` in the cotal config now refuses a `COTAL_` name the launcher sets for each seat, such as `COTAL_ROLE`, `COTAL_MODEL` or `COTAL_SUBSCRIBE`, and the spawn fails before launch with an error naming the entry. Before, a launch with no role, model or channels of its own forwarded the spawning process's value, and the seat read it as its own role, model pin or read set while the launcher showed none. The machine-wide knobs such as `COTAL_HOME` may still be listed, and names outside the `COTAL_` namespace forward as before.
