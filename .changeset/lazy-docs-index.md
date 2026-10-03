---
"@cotal-ai/connector-core": patch
---

Build the `cotal_docs` search index on the first search instead of at import. Every connector MCP helper imported it, so each agent paid for tokenizing the whole docs bundle at startup — a heap burst that roughly doubled the helper's footprint after boot and left ~17MB resident for a tool most sessions never call.
