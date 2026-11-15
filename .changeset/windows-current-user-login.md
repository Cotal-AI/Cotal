---
"cotal-ai": patch
---

Windows desktop `Open at login` now reads and writes only the current user's `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` entry (honoring `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`) instead of registering Cotal for all users in `HKLM` when the app runs elevated. When a leftover `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` `Cotal` value points at this executable, the app removes it when running elevated or reports it on the existing login toggle error surface while keeping the toggle at the current user's state.
