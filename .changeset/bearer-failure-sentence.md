---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

A bearer command that fails without printing a sentence of its own now reports its cause. The agent auth preflight in `cotal spawn` and in the manager, and a running agent's bearer refresh, reported such a failure with Node's `Command failed` line, which repeated the whole bearer argv (exchange URL or state dir, space, owner, actor, token file and health file) and never said whether the child timed out, was killed or exited. The error now says the bearer command timed out after its limit, was killed by a named signal, or exited with a named code and printed nothing. A failure the command explains on stderr is still reported with that sentence. `bearerCommandFailure` in `@cotal-ai/core` builds the error.
