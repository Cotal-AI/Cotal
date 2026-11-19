---
"@cotal-ai/connector-opencode": patch
---

Move the OpenCode plugin's shared seams (retirement and settle tokens, the model refusal check, the bounded settle and the surfaced inbox batch) out of `plugin.ts` into `plugin-seams.ts`. `plugin.ts` re-exports them, so imports and behaviour are unchanged.
