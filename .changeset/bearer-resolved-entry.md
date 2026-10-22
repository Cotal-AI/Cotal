---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

A user-auth seat's bearer command now names the CLI entry file that the `cotal` bin link resolved to, instead of the link. Before, an install that replaced the link with a launcher Node cannot load cut every running seat off the mesh at its next bearer refresh. Running the get.cotal.ai installer over an `npm i -g` install is one such install: it writes a shell script over `~/.local/bin/cotal`.
