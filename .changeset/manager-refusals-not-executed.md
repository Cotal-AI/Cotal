---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

Report a manager refusal that happened before anything ran as a refusal. The manager now marks its control refusals `not-executed` when it can show no effect started: admission and permission refusals, a stale target, input or attach into an agent that was replaced or is not running, a runtime with no input, and a spawn or launch refused before the name reserve or a launch file write, such as a missing persona. `cotal spawn --detach`, `stop`, `input` and `attach` then report `refused` with exit 2 and print the manager's reason on one line, naming the agent. A failure after an effect may have started, such as a terminal write the runtime rejected, stays `unknown` with exit 3 and now shows the manager's reason too. A user-mode `ps` or `slots` read the manager refused itself keeps its own reason and no longer gets the admin-scope hint meant for a broker refusal.
