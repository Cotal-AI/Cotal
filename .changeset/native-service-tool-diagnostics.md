---
"cotal-ai": patch
---

Windows background service installation avoids slow PowerShell command discovery on a new user profile. Task lookup imports ScheduledTasks directly, retaining the existing ownership checks and 30-second budget. Native failures also distinguish timeout, startup errors, output overflow and terminating signals with elapsed time and the native error code.
