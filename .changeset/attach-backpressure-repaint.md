---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

`cotal attach` now coalesces rapid wheel input and PTY redraw bursts, waits for local stdout drain
before returning session credit, and automatically repaints the canonical terminal snapshot after an
explicit backpressure drop. Session teardown also lets the distinct terminal reason drain before the
unsequenced close control can overtake it. The bounded 64-frame rail window is unchanged.
