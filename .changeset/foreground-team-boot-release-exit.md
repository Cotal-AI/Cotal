---
"@cotal-ai/cli": patch
---

A foreground `cotal team boot` that another command's `cotal down` releases now exits 0, as a foreground `cotal up` does. It used to keep the exit code 4 of its partial start receipt, so a script waiting on it read a normal stop as a failure.
