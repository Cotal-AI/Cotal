---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal service status --instance` of a background service with no recorded supervisor whose process
ended after readiness, with no stop through the controller, now names `cotal service logs <name> --space <space> --instance <id>` in its
Next. Before, it showed only "Process observation: gone" and "Process stop evidence: not recorded",
without pointing to that instance's recorded output. No exit code or signal is reported, because
none was observed. The log may contain output explaining the exit; it is not guaranteed to do so.
