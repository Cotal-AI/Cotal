---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

The macOS background service now installs updates automatically when automatic updates are on. It hands the existing guarded updater to a separate one-shot launchd job so restarting the service does not stop installation or extension reconciliation. Failed handoffs report their reason and the manual update command. A Mac on a version before this one needs one `cotal update --self`, and updates itself from then on.
