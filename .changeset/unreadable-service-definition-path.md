---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A saved definition of a service you added that is not valid JSON, as an interrupted write can leave
it, is now named by `service` and its verbs, such as `service show`, `service add` and
`service stop`. The `SCHEMA_INVALID` refusal gives its path, the `mv` that moves it aside, and
`cotal service add <name> --file <declaration>`, which adds the service again so that an instance
still running can be stopped. Before, the refusal named no file, so the stop that `down` names for a
running service could not be followed. A stack member's definition keeps the plain refusal.
