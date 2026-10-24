---
"@cotal-ai/cli": patch
---

`cotal up --open` or `cotal up --user-auth` on a root whose first `up` recorded another mode now names a way that works: keep the recorded mode with a bare `cotal up`, or run `cotal space create` and the other mode's `up` in another folder. The docs for `up` and `reset` say that no reset, clean or forget changes a root's mode.
