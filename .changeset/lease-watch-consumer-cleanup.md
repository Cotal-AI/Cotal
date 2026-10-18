---
"@cotal-ai/core": patch
---

The delivery daemon's lease watch now deletes its broker consumer when its stop handle runs, when the endpoint stops, when a manual reconnect retires a live connection, and when a newer lease watch replaces it mid-bind. Each of those retirements used to leave an idle consumer on the space's delivery bucket for five minutes. A lease-watch bind still in flight when the endpoint stops or reconnects now deletes its consumer instead of installing a watch for the retired connection, and that bind no longer delivers a lease event after `stop()` has begun.
