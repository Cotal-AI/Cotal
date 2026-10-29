---
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-core": patch
---

Clarify that Codex automatic-message steering applies to connector-started turns. Messages received during attached-TUI turns or native goal continuations wait for a connector delivery turn, with acknowledgements still committed at that delivery turn's boundary.
