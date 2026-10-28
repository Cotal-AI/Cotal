---
"@cotal-ai/cli": patch
---

`cotal update` and `cotal update --self` refused by a running manager's legacy custody ("this update is not a hot update") now print the next step: stop that mesh with `cotal down --space <space>`, then run the update again. Before, the verdict and the per-seat continuity classes were all the command said before exiting nonzero.
