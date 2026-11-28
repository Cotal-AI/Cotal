---
"@cotal-ai/cli": patch
---

When the built-in connectors already verify, an unfetchable optional extension no longer blocks ordinary commands or leaves a failed seed cursor after `cotal update`. If npm cannot remove a missing optional extension from a packed install offline with an empty cache, `cotal ext remove` leaves the installation unchanged and prints the command to retry online.
