---
"@cotal-ai/web": patch
---

Stop unfinished legacy dashboard delete uploads after ten seconds without changing the channel.
The body deadline returns HTTP 408 and closes the connection even when the caller keeps sending small chunks. The existing 8 KiB limit and read-only service refusal are unchanged.
