---
"@cotal-ai/cli": patch
---

On a static or open mesh, `cotal attach --on` and `cotal input --on` with an id the registry lists for no manager are refused `TARGET_NOT_FOUND` at once, naming the managers that run, as `stop --on` is. Before, each waited out the 10 s answer deadline, and `input` then said the manager registered for this space did not answer. A registered manager that does not answer is still waited on, and a user-auth mesh is unchanged.
