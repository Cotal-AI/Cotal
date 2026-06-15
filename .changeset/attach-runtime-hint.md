---
"@cotal-ai/manager": patch
---

`cotal attach` now gives runtime-correct guidance. The manager previously assumed any non-`pty`
runtime was tmux, so cmux users were told to run a `tmux attach` command that doesn't apply.
`opAttach` now delegates to the agent handle's own `attach()`, so each runtime speaks for itself:
tmux → `tmux attach -t cotal-<space>:<name>`, cmux → switch to the `cotal-<name>` tab.
