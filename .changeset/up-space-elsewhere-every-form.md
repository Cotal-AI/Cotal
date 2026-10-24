---
"@cotal-ai/cli": patch
---

`cotal up --space <space>` from another folder, while that space runs from its own folder, refuses `CONFLICT` naming that folder with `--json` and `--plain` too, and with no `--server`. Those forms used to refuse `UNSUPPORTED` about the launcher, aimed at the calling folder, and the form with no `--server` left an empty `.cotal/nats` in the calling folder.
