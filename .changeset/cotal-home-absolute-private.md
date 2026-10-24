---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A relative `COTAL_HOME` is refused with `USAGE_INVALID` before any command runs, since each folder
would otherwise have its own home. Cotal no longer writes a space, a registry entry, the current
selection or a service record into a home that another account could replace or write, or under a
folder another account could write: the write is refused, naming each path and the `chmod` that
fixes it. A home others can only read is made private on the write, and `cotal setup --skills` no
longer creates the home readable by others. Reading service records from a home that is not private
now names the path and the fix.
