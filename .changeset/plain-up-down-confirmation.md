---
"@cotal-ai/cli": patch
---

Require confirmation before stopping a stack started with plain `cotal up`.
Noninteractive stops now need `--yes`, as prepared stacks already do. Interactive
stops show the retained components and default to No. Previews and already-stopped
stacks still need no confirmation.
