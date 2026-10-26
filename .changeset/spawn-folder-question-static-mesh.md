---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

The folder question a managed launch asks in a terminal now works on a static mesh. An operator
instrument carries `resolve-cwd` on the manager it pins, the read that question's check needs, so a
typed folder is resolved by that manager instead of refused at the broker, and a folder it cannot
use is shown with its reason and asked again. A check that could not be made at all keeps the
responder's internals out of its sentence and names the `-C <dir>` that sends the folder with the
launch.

The question also reads the host the manager reports, the name `cotal ps` prints as its reported
host, so a manager running on this host is no longer asked about and its receipt no longer says the
host was not reported. The mesh and the pin are read before anything is asked, so a stopped mesh or
an `--on` that names no running manager is refused first.
