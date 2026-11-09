---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Guided service and endpoint forms validate answers at each question so invalid input can be corrected without losing earlier answers.

Preset answers use the option schema and path checks, including the broker server's existing address restrictions. Imports and endpoint references are checked before the form advances, and whole-definition validation remains in place before saving.
