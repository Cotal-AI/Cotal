---
"cotal-ai": patch
---

Node-version preflight now gives the remedy that matches how cotal was installed. When the
launcher written by `curl -fsSL https://get.cotal.ai | sh` is in use (it sets
`COTAL_LAUNCHER=1`), a pinned runtime that has been replaced by an older Node points at
re-running the installer, or at `--vendor-node` to stop depending on the system Node
entirely, rather than at generic nvm advice. Installs that did not come from the installer
keep the nvm guidance and now also mention the installer as an option.
