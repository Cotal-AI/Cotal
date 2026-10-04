---
---

`pnpm smoke:gate-inventory` now reads the entry file of every suite the gate reaches. It refuses a `finally` exit that can turn a throw into exit 0, and it refuses a suite that pins no expected cell count unless the suite is listed in `bin/smoke/unpinned-suites.txt`, the existing debt, which may only shrink.
