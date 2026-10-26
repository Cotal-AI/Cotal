---
"@cotal-ai/workspace": minor
---

Remove the deprecated `removeIdentityPin` export, which could strip a live record's identity pin
without taking the publish lock or checking for a successor. Use `removePidPair(pidfilePath,
recorded)` after proving the recorded process has stopped. Pass the trimmed pidfile content that
was adjudicated so a concurrent successor keeps its pidfile and pin.
