---
"@cotal-ai/pi": patch
---

The pi adapter hands pi the plain Zod JSON Schema render instead of a TypeBox-branded copy, so a JSON round-trip of every tool's parameters carries only schema keywords and a strict provider no longer refuses the declarations.
