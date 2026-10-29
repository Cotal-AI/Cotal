---
"@cotal-ai/core": minor
"@cotal-ai/tmux": minor
"@cotal-ai/cmux": minor
"@cotal-ai/connector-core": patch
"@cotal-ai/orca": patch
---

`@cotal-ai/core` no longer exports the `terminal` extension kind (`TerminalLayout`, `Tab` and `Pane`), and `@cotal-ai/tmux` and `@cotal-ai/cmux` no longer export or register `tmuxTerminalProvider` and `cmuxTerminalProvider`, along with the layout code only those providers used. Nothing in Cotal has resolved the kind since `cotal setup` became configure-only, while the contract and both providers still named `cotal setup` as their consumer. Spawned tmux and cmux agents launch as before; the cmux pane launcher keeps its `env -i` isolation and drops the login-shell and inherited-environment modes that only layout panes used. The upgrading guide lists the imports to remove.
