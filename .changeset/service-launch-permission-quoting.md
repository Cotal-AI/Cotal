---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Quote executable and working-directory paths in launch-permission repair commands, so spaces
and apostrophes remain part of one path when the command is copied into a shell. Refusal codes,
launch checks and permissions are unchanged; repairs are never applied automatically.
