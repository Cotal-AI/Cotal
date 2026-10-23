---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`COTAL_DEBUG=1` now prints a stack trace for a command that fails with a reported error, such as a failed `ep describe`, as docs/config.md says. It prints the failure's stack and then the stack of each error that caused it, so an endpoint call's underlying error, for example `no describe reply ... within 10000ms`, is visible. It used to print nothing for these failures. The JSON envelope is unchanged.
