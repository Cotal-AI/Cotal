---
"@cotal-ai/pi": patch
---

Call the inbox commit in `PiDriver.finalizeEnd` as a plain statement. The method bound the commit counts to a local it never read, which suggested a later use that did not exist. Behavior is unchanged.
