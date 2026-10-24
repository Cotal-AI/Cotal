---
"@cotal-ai/cli": patch
---

A `persona edit` interrupted while the editor is open now says so. The CLI passes the SIGINT,
SIGTERM or SIGHUP to the editor and waits for it, so the editor no longer keeps running after the
CLI exits. SIGTERM and SIGHUP, or a Ctrl-C that ends the editor, save nothing, remove an unchanged
draft, keep and name a changed one, and exit 130, 143 or 129 with a notice. It used to exit with no
message and leave the draft in the temporary directory. An editor that takes Ctrl-C as a key, as vim
does, keeps the edit going.
