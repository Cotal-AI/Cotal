---
"@cotal-ai/manager": patch
---

The manager's `spawn` operation refuses an empty or whitespace-only value in its optional string fields (`agent`, `defaultAgent`, `role`, `config`, `identity`, `model`, `variant`, `resume`, `resumeClaim`, `resumeAgent`, `cwd`, `prompt`) with `bad-request` naming the field. Before, an empty value was read as omitted, so `cotal spawn --detach --role ""` or `--agent ""` launched on the persona's role or `agent:` pin without saying so, while a whitespace-only value of the same field was refused or forwarded. The manager cluster document moves to revision 24.
