---
"@cotal-ai/cli": patch
---

The delivery cutover preflight now checks the delivery-aware marker against the manager pid it attributed and no longer reads the manager pidfile a second time. A delivery-aware manager that exits or is replaced while `cotal up` runs the preflight is no longer reported as an old Plane-3-hosting manager and stopped. `cotal status` and the `cotal up --runtime` reuse warning check the marker against the pid from their own record read.
