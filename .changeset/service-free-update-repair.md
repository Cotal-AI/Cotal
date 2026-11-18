---
"cotal-ai": patch
---

Recover interrupted Linux self-updates without a recorded machine service or user D-Bus connection.
The repair still checks for other application processes and retains the original marker under the global update lock. It excludes the invoking command's ancestors, including a container's init process, from that census.
