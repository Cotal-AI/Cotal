---
"@cotal-ai/pi": patch
---

A Pi seat now receives messages that arrive during a long run at its next turn boundary instead of only when the run ends. On transports without a provider response hook, such as the Codex subscription, Pi running a tool from an answer now confirms the batch that request carried. A steer sent while a tool runs no longer trips the dispatch watchdog's hold, which used to block every later message for the rest of the run.
