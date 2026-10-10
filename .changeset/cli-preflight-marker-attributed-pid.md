---
"@cotal-ai/cli": patch
---

The delivery cutover preflight now checks the delivery-aware marker against the manager pid it attributed, without reading the manager pidfile a second time, and its stop signals only that pid. A delivery-aware manager that exits while `cotal up` runs the preflight is no longer reported as an old Plane-3-hosting manager, and a manager that replaces the record meanwhile is no longer stopped in place of the one the preflight judged. `cotal status` and the `cotal up --runtime` reuse warning check the marker against the pid from their own record read.
