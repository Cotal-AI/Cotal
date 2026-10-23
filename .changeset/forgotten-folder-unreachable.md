---
"@cotal-ai/workspace": patch
---

A command such as `cotal channel` run in the folder of a forgotten prepared space, with no broker at the default address, now says that no space is registered or prepared for that folder and names `cotal space create <name> --root <root>`. It used to say that mesh `main` was recorded there on 127.0.0.1:4222 and to run `cotal up` to restart it, though nothing recorded `main` there.
