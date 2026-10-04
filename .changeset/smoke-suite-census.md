---
---

`pnpm smoke:gate-inventory` now reads the entry file of every suite the gate reaches. It refuses a `finally` exit that can turn a throw into exit 0, judging each catch arm against the exit it guards. It refuses a suite whose expected cell count is not compared where the run reaches it and a mismatch fails the run, unless the suite is listed in `bin/smoke/unpinned-suites.txt`, the existing debt, held to a ceiling in the gate. A reached suite whose entry file cannot be read is refused unless it is listed with a reason.
