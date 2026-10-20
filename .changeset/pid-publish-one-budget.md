---
"@cotal-ai/workspace": patch
---

On Windows, publishing a process record now waits at most 5 s in total for files another handle holds open. Before, each of its three renames could wait 10 s on its own, so one publish could block for nearly 30 s under the publish lock, about the time a second writer waits for that lock before giving up (#4175). All the renames of one publish now share one 5 s budget, and a refusal that outlasts it still throws.
