---
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
---

`ps` and the hosted `run` verbs now say what to do when the space's manager runs but does not
answer. `ps` waited out its deadline and refused "no manager reachable" with no Next, although this
root's stack manager was running. It now names that manager's pid and gives as Next ending that
process, so bare `cotal up` starts the manager again. `run start`, `run ps` and the other hosted
verbs exited 1, the usage code, with only the rail paragraph. They now refuse `TARGET_UNAVAILABLE`
(exit 2) with the same sentence, and their Next is `cotal status`, which names a stack manager that
runs but does not answer, with its pid.
