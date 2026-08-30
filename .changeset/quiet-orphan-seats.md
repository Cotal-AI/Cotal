---
"@cotal-ai/manager": patch
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/tmux": patch
"@cotal-ai/cmux": patch
"@cotal-ai/orca": patch
"@cotal-ai/herdr": patch
---

Prevent manager succession from proceeding over seats whose exit was not verified. Normal shutdown waits for every managed seat to exit before releasing manager authority. Crash recovery uses runtime-owned durable locators to reap the exact orphan surface, verifies its broker principal gone, records the eviction evidence, and only then retires the lifecycle and frees the alias.
