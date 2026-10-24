---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

When a project's `.cotal` was moved to another folder and linked back, `up`, `down` and `status` in
the project, and every command in the folder the records were moved to, no longer send you from one
folder to the other. They name the way back: remove the link, then move that `.cotal` back in its
place, which keeps the history. Nothing is moved for you.
