---
"@cotal-ai/cli": patch
---

An unpinned `spawn -d` that no manager takes no longer waits out the reply deadline on a registered manager whose host is gone. It skips a manager the broker reports nothing subscribed on, names it in a `MANAGER_SILENT` warning, and gives the reason the managers that answered report, such as none having an agent application installed.
