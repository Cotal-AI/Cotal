---
"@cotal-ai/connector-opencode": patch
---

On OpenCode 2.x, a plugin setup that refuses now makes every later setup in the same server process refuse with the same error. The setup guard was committed before validation, so after a refused first setup the next one returned as if an agent were running.
