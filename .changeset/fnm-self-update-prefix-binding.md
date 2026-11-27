---
"cotal-ai": patch
---

Bind staged `cotal update --self` execution descriptors to the Node installation prefix's `bin` entry instead of transient version-manager shell symlinks such as `fnm_multishells`, so switching Node versions does not revert the active CLI generation or break concurrent shells.
