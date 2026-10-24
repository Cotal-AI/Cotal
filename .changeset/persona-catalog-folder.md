---
"@cotal-ai/cli": patch
---

A `.cotal/agents` that is a file or a link that loops is now refused with `CONFLICT` by the persona
listings, `show`, `create`, `edit` and `remove`, naming it and what it is, instead of a permission
refusal that named the project folder or a listing that showed no personas.
