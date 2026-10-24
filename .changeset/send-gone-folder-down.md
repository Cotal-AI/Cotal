---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A command that connects to a static-auth space whose stack folder was deleted while the stack ran,
such as `send` or `history`, no longer says to restore the seed at that checkout. It says the
folder is gone with its seed and names `cotal down --space <space> --yes`, the stop `status`
already offers. Its JSON refusal now carries the space and folder as its target.
