---
"@cotal-ai/cli": patch
---

JSON history follows now report rejected arguments and local setup errors as a stream error followed by an end record. These refusals keep their error code and exit status without connecting to the broker.
