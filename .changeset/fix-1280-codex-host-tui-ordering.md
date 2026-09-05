---
"@cotal-ai/connector-codex": patch
---

Stabilize the codex host smoke: two checks that count the launch tail's TUI log line now wait for that line to be written before counting, so a slow TUI child can no longer red the shard on a scheduling accident. The exact-count check waits for the superseded launch tail to stand down before counting so it still catches a launch that attaches more than one TUI, and the replacement-TUI check waits for the second TUI with the timeout as its failure.
