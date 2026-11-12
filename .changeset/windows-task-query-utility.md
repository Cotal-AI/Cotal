---
"cotal-ai": patch
---

Windows background task checks import their PowerShell utility commands explicitly. Task lookup imports Microsoft.PowerShell.Utility alongside ScheduledTasks before using New-Object or ConvertTo-Json, retaining the existing ownership checks and 30-second native tool budget.
