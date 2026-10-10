---
"@cotal-ai/workspace": patch
---

A seat writer generation file is now keyed by `spaceKey` of the space and of the seat name, joined by `00`, and one builder names it for both the claim and the load. An empty space, a name with an unpaired surrogate and a space or seat name containing NUL are refused instead of written, so two different seats can no longer share one generation file and refuse each other's claim. Every key a valid seat already has is unchanged. The account record filename is also built in one place now, for both its file path and its store key.
