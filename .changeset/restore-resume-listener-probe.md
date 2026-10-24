---
"@cotal-ai/cli": patch
---

`backup restore`, `up --restore` and a bare `up` that resumes a preserved cut now probe the broker
address they will bind before they move or start anything, as `backup create` does. While another
process listens there they refuse `CONFLICT` (exit 2), name the address and leave the cut unchanged.
Before, the restore went past its commit point and the resume started, the broker failed to bind,
the command exited 3, and the root was left degraded.
