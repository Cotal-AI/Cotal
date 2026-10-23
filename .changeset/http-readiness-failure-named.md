---
"@cotal-ai/cli": patch
---

A `service start` whose HTTP readiness check never succeeded said only that the process did not establish its declared readiness, with no address, no hint of what the check saw, and a generic Next. It now names the loopback address (not the URL's path), the expected status, the deadline and the last observation, such as a refused connection or another status, says the process was left running, and its Next names the `service logs` and `service stop` commands for that exact instance.
