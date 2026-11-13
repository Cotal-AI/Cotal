---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal status` no longer waits while another `cotal` command changes the installation. It used to queue behind a `cotal setup`, `ext add`, `ext seed` or update that was preparing connectors, for as long as that took and up to five minutes, printing nothing. It now reports that command by process id, leaves the application rows unread, marks the report partial (exit 4) and returns at once. Run it again when that command finishes for the full report.
