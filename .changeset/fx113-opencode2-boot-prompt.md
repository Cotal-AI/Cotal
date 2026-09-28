---
"@cotal-ai/connector-opencode": patch
---

Fixed the OpenCode 2.x adapter dropping `cotal spawn --prompt`'s kickoff text: `plugin2.ts` now reads `COTAL_OPENCODE_PROMPT` and submits it as its first connector-driven turn, alongside the briefing and the persona as `system`, the same floor the 1.x plugin already runs. A failed first submission keeps the text for the next drive.
