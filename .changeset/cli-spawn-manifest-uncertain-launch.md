---
"@cotal-ai/cli": patch
---

`cotal spawn -f` now records an agent whose launch settles uncertain in the run's ledger and lists it as pending. Such an agent neither joined the mesh nor exited within the readiness window, and the manager keeps managing it. It used to print as a failed launch with no ledger row, so `cotal down -f` never stopped it. An agent that exits on launch is still a failure with no ledger row.
