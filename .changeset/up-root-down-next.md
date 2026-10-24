---
"@cotal-ai/cli": patch
---

`cotal up --root <root>` run from another folder now says in its Next to run `cotal down` from that root, since `down` stops only the stack of the folder it runs in, and offers `cotal up --root <root>` to add the manager. It used to offer a bare `cotal down`, which refuses from the folder you ran `up` in.
