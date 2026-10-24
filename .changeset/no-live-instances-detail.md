---
"@cotal-ai/core": patch
---

The refusal for a service with no live instance, such as `ps` or `models` on a stack started with `--no-manager`, no longer carries the spec rule "an empty registry is never an empty scatter success (SPEC 13.5)" in its native detail. The detail now says only that the service has no live registered instances.
