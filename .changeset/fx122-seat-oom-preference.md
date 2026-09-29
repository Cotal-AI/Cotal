---
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
---

Pty seats are marked more killable than the broker (`oom_score_adj` 500 on the seat's PTY child), with a logged reason when the kernel refuses and an explicit unavailable line off Linux.
