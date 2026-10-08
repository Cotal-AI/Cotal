---
"@cotal-ai/core": minor
"@cotal-ai/tmux": minor
"@cotal-ai/cmux": minor
---

`Pane.confirm` is removed, and the tmux and cmux terminal-layout providers no longer press Enter in the panes they open. The flag carried no prompt text, so both providers pressed Enter five times, one second apart, and answered the first dialog a pane showed with its default, while a prompt that never appeared went unreported. Nothing in Cotal set it. A `Pane` literal that sets `confirm` no longer compiles; see the upgrading guide.
