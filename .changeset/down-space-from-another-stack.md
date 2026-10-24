---
"@cotal-ai/cli": patch
---

`cotal down --space <space>` run from another controller stack's folder now names the space it was given, labels the refusal with it, names that space's root when this machine started it elsewhere, and gives a next step that runs the same `down` from there. It used to call the given space "the selected space", label the refusal with the folder's own space and give no next step.
