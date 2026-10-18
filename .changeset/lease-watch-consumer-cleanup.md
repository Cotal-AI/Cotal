---
"@cotal-ai/core": patch
---

The delivery daemon's lease watch now deletes its broker consumer when its stop handle runs, when the endpoint stops, when a manual reconnect retires a live connection, and when a newer lease watch replaces it mid-bind. Each of those retirements used to leave an idle consumer on the space's delivery bucket for five minutes.
