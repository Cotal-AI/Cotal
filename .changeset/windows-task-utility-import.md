---
"cotal-ai": patch
---

The Windows daemon task check imports Microsoft.PowerShell.Utility before New-Object and ConvertTo-Json. The check no longer waits on PowerShell command discovery, and the 30 second limit is unchanged.
