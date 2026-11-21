---
"@cotal-ai/cli": patch
---

JSON history follows now report argument refusals as a complete stream error followed by an end record. Invalid read filters and target values still exit with status 1 without connecting to the broker.
