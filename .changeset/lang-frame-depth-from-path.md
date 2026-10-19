---
"@cotal-ai/lang": patch
---

Both engines now read a frame's concurrency depth from the length of its key scope path instead of storing it beside the path as a second constructor field. A frame therefore always reports one level per enclosing scope, and the run-time L2032 check compares against, and names, the scope that raised the frame to its depth.
