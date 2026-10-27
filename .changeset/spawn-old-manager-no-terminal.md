---
"@cotal-ai/cli": patch
---

A foreground `cotal spawn --on <instance>` on a manager from before 0.104.2, which does not report whether its runtime streams a terminal, no longer ends `OPERATION_PARTIAL` on a runtime such as `orca` or `tmux` that has none. The CLI still finds out by attaching, and when the manager refuses that attach because the runtime streams no terminal, the launch ends with the receipt, one line naming the runtime, and exit 0. Such a manager does not mark that refusal, so the CLI accepts it only for a runtime whose provider, registered or installed with this CLI, declares no terminal. Any other attach failure after a successful launch is still partial, exit 4, and now prints the manager's reason as a `Native detail` row (`error.cause.detail` in an envelope). Its Next gives `cotal ps` and `cotal attach` with the real space and manager instance, or the runtime's own session where it streams no terminal, in place of a bare "reattach".
