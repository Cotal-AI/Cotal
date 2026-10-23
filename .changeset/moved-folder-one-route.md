---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A controller project folder moved after its stack stopped got contradictory next steps: `up` and `down` said to move it back, while `status`, `send` and `history` said to forget the space and prepare it again with `space create --root <dir>`, which `space create` then refused. Every command run there now names the same next step. A folder moved on this machine is told to move back. When this machine records neither the space nor an instance of its stack, as for a copy brought from another machine, moving back would not start it, so `up` and `down` now name only `space create <space> --adopt`, as `status` already did. When the space is prepared or registered here, they name moving back or forgetting the space and adopting the journal.
