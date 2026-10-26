---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A managed launch that waits for you before it joins no longer ends as an unknown outcome. A
connector can name the screen a launch waits at (`waitsForOperator`), and Claude does for
`--opt resume=` with no session id, which opens its session picker. The manager reports such a
launch ready once its process runs, and `cotal spawn` says the agent is waiting for you at that
screen and attaches to it in a terminal, `-d` included, or prints the attach command, exiting 0.
When the readiness window passes and the manager saw the agent's process still running, the
`uncertain` result carries an `ai.cotal.goal.entity-running` detail, and `cotal spawn` says the
agent has not joined yet and how to attach instead of reporting an unknown outcome.
