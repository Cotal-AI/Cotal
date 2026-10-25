---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A `clean store`, `clean all`, `reset store` or `reset space` whose removal stops inside the
`.cotal-clean-<id>` folder the store was moved to now ends `OPERATION_PARTIAL`, naming that folder,
what is left in it and the step that removes it. It used to end with the raw error, or as an unknown
outcome that named only the original store path, which no longer existed.
