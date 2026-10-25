---
"@cotal-ai/cli": patch
---

`auth mint <label> --replace` now warns `REPLACED_GRANTS_CHANGED` when the replacement's grants differ
from those of the agent credential it replaced, as when it is run with no grant flags. The warning
names both sets of grants and the `--allow-subscribe`, `--allow-publish` and `--role` flags that name
the replaced ones. The grants a replacement holds are unchanged.
