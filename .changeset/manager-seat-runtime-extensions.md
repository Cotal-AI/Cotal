---
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A manager imports an installed runtime extension on demand when a managed seat names it with `spawn --runtime <name>`, and when it resumes a retained seat that was launched on one, through the same installed-extension lookup `up --runtime` uses. A `pty` manager started after `cotal ext add @cotal-ai/tmux` used to refuse `spawn -d --runtime tmux` as an unknown runtime, because its process had imported only its own runtime. A runtime removed with `cotal ext remove` is refused for the next seat even while an earlier import keeps it registered, and seats already on it keep their backend. The manager's refusal for an uninstalled runtime now names the official package, from the same table and wording the CLI uses, which moved from the CLI into `@cotal-ai/workspace`.
