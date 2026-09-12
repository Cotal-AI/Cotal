---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
"cotal-ai": patch
---

Merge a complete agent file passed as a cotal_persona prompt into one frontmatter block. Authored channel grants, role, and agent survive load, explicit tool arguments win, and a malformed leading fence is refused rather than wrapped.
