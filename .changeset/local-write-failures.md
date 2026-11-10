---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Local write failures now name the affected file, explain the storage limit and offer a next step.
Failed preferences and persona writes preserve the saved destination, persona draft failures are
no longer called invalid input, and space creation reports any earlier changes when a later write
fails. Failed lock and prepared-record writes clean up their temporary files.
