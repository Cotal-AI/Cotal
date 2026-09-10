---
"@cotal-ai/manager": patch
---

`MAX_AGENTS` is declared once, exported from `resume.ts`, and imported by `manager.ts`. The two private copies (spawn/resume capacity checks and the resume inventory schema's array cap) could drift apart silently: raising the ceiling in `manager.ts` left resume inventories refused above 50 with a zod length error that never mentioned capacity.
