---
"@cotal-ai/connector-hermes": patch
---

The Hermes connector accepts `cotal spawn --resume <id>`. Before the seat joins the mesh, the launcher forks the named session out of the operator's Hermes profile (`HERMES_HOME`, or `~/.hermes`) into the seat's managed profile through Hermes' own session store, reading the source database read-only. Each mesh chat whose session is still empty starts as a branch of that fork, so its first turn carries the source context. A missing or empty session is refused before the seat joins, a seat relaunched under the same name keeps its fork without reading the source again, and resume is refused together with `COTAL_HERMES_ADOPT_HOME`.
