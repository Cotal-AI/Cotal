---
"@cotal-ai/web": patch
---

Move the web dashboard's request input and operator text handling (caller errors, body caps, operator quoting and escaping, and channel, history, agent-id and tap parsing) out of `web.ts` into `web-request.ts`. `web.ts` re-exports the public names, so imports and behaviour are unchanged.
