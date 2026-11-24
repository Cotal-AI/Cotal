---
"@cotal-ai/acp": patch
---

The T3 Code and Zed entries that `cotal setup` writes keep working after Node or Cotal is upgraded.
Under the get.cotal.ai launcher, an entry now runs the launcher's Node link instead of the folder of one Node version, such as Homebrew's `Cellar/node/<version>`, which Homebrew removes when Node upgrades. It also runs the install's own entry instead of the copy one update loaded. Status counts a link to the running Node as current.
