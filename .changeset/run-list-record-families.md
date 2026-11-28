---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
---

`cotal run` lists the runs recorded in a space without reading the rest of that space's record store, so a store that has grown for days still answers inside the list budget. A list that still misses its budget says it may miss it again and names `cotal run --page --on <instance>`, which needs a manager at contract revision 29 or later. `--creds` prints as `<file>`, and a server address that carries credentials is left out.
