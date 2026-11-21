---
"@cotal-ai/cli": patch
---

JSON history follows now report invalid read arguments as a stream error followed by an end record. They still exit with status 1 without connecting to the broker.
