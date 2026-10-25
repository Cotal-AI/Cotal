---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal service status --instance` of a service whose process ended after readiness, with no stop
through the controller, now names `cotal service logs <name> --space <space> --instance <id>` in its
Next. Before, it showed only "Process observation: gone" and "Process stop evidence: not recorded",
so the cause, which only the service's own log keeps, was not pointed to. No exit code or signal is
reported, because none was observed.
