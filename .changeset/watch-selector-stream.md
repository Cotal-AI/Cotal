---
"@cotal-ai/cli": patch
---

JSON watch and history follow streams report an invalid broker URL or empty space selector with an error record and an end record. They exit with status 1 without connecting to the broker.
