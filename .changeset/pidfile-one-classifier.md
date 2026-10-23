---
"@cotal-ai/cli": patch
---

The CLI now classifies a local pidfile in one place, read through the shared pidfile reader. A pidfile that exists but cannot be read, such as a directory, now reports an error naming its path. `cotal status` used to print only the bare read error on that component's row.
