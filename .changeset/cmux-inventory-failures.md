---
"@cotal-ai/cmux": patch
---

cmux workspace listing and label lookup now report missing, failed or timed-out CLI reads instead
of returning an empty list. All inventory readers use the existing one-second probe bound. Healthy
listings, public exports and the CLI's default line format are unchanged.
