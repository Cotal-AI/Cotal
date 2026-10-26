---
"@cotal-ai/cli": patch
---

A bare `cotal down` in a folder with no stack now names the space the selected one is, the folder
this machine started it in, and the same `down` to run from there, for every stack `cotal up`
registered rather than only a controller one. It used to say only that this folder's root holds no
stack and point at "the folder where `cotal up` started the stack" without naming it, so a script
and an operator both had to find it. `--json` and `--plain` carry that refusal as structured output
instead of refusing `UNSUPPORTED`, so a script reads the same code as the plain run.
