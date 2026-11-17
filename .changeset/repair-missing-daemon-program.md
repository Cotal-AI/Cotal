---
"cotal-ai": patch
---

Repair an enabled background service when its recorded executable or CLI entry has been removed.

Manual updates verify the recorded service, fence empty hosted Managers, and replace the missing launch coordinates with the current CLI installation. Repairs serialize native lifecycle changes, prepare replacement files before stopping, and retain the original source and receipt for guarded recovery on failure. Disabled services, modified sources, present non-file launch paths, and present unrelated installations are retained. Update output now distinguishes an answering foreign daemon from an endpoint that is not running.
