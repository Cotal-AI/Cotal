---
"@cotal-ai/workspace": patch
"@cotal-ai/runtime": patch
"@cotal-ai/cli": patch
---

On a terminal, more Next lines now keep each command whole when they wrap. Four of them name their
commands in backticks now: `space delete` of a running space, `run answer` with a step name that
matches an open request, `down` and `down --dry-run` beside a running service, and `up` in a moved
folder that `space create --adopt` takes over. Before, at 80 columns, the `space delete --dry-run`
Verdict of a space with a long name printed `cotal reset store` at the end of one line and the
name on the next.
