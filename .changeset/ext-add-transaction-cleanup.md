---
"@cotal-ai/cli": patch
---

When `cotal ext add` is interrupted by `SIGINT` or `SIGTERM`, it now rolls back the staged install, releases the extension lock and seed marker in one cleanup path, and sets exit code 130 in the CLI command rather than terminating the process from the install helper.
