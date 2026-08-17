---
---

Test-only: keeps the mutation-fixture walk out of git submodules, so the gate reads the same file
set locally as it does on CI, and adds four self-check cells (one of which reports itself
unobserved rather than passing when the submodule is absent). No shipped behaviour changes, so no
release.
