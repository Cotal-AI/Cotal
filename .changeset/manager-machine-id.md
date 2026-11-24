---
"@cotal-ai/acp": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/workspace": minor
---

`cotal acp` now recognises this machine's manager after the machine's host name changes, as macOS does when the network changes, so it no longer starts a second manager or defaults a thread to another computer. A Manager's `status` and presence card carry `machine`, an HMAC-SHA256 of the host's OS machine identity keyed by it over `cotal manager host`, and the bridge compares it with its own; the host name is only shown. A manager that names no machine counts as another computer's. The Manager cluster advances to revision 55, and its closed status schema of revision 54 rejects the field, so update Managers and their callers together, as revision 54 already requires. `@cotal-ai/workspace` exports `osMachineId()`, the OS machine identity read the CLI's service records use, and `managerMachineId()`; `reportedManagerHost` answers `{ host, machine }`.
