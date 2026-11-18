---
"cotal-ai": patch
"@cotal-ai/seat": patch
---

Repair a recorded macOS background service when its application executable has been removed.

The CLI verifies the original LaunchAgent and receipt before moving the service to the current installation. Interrupted source and receipt publication retain a bounded repair record, disabled services stay disabled, and updater output no longer claims that an untouched foreign service was stopped.
