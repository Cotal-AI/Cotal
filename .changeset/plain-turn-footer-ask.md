---
"@cotal-ai/connector-core": patch
---

A surfaced run turn tells the seat to answer an ask through its native route only when a block above carries one. A plain `turn`, including one named `ask`, gets only the ordinary-turn footer, so a seat no longer goes looking for a question, schema or answer route that was never sent.
