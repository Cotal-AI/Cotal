---
"@cotal-ai/connector-claude-code": patch
---

`cotal update` now installs the `cotal` plugin at user scope on a machine that only has the per-project installs earlier releases made, so it loads in every project, and removes the per-project installs that had it on. A project that turned the plugin off keeps it off, and an account that turned it off is left as it is.
