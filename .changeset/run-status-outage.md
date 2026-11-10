---
"@cotal-ai/runtime": patch
---

Hosted runs record their final status after a broker outage instead of remaining marked as running after the driver releases them. The manager retains the attempt while retrying the status write, stops recovery when its connection closes, and never overwrites a successor's status.
