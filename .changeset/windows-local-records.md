---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Read and write Cotal's local records on Windows, so `cotal up`, `status` and `down` run there. Local records such as the stack journal, service records and deployment attempts now use the access-list model Cotal already uses for private files on Windows. A store directory Cotal creates gets the private access list, and a record is written like a private secret. Reading a record or checking its path there does not check a POSIX owner or mode and does not refuse a link: a symlink or junction is followed. Size limits, the record schema, the regular-file check and the refusal of a link inside a record store's own directories still apply. On Windows, `cotal ext add` and the setup seed now record a service receipt, `cotal status` reads the deployment-attempt inventory, the `down --dry-run` and `team deploy` previews read their records, and `cotal ext remove` accepts the service namespace without a POSIX owner. Starting a process service there still refuses, because the process driver needs Linux machine and boot identity. Linux and macOS are unchanged.
