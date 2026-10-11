---
"@cotal-ai/workspace": patch
---

The control target resolver now throws a user-auth mesh's connect refusal when its caller asks for the throwing form, as it already did on a static mesh. It used to print the refusal and exit the process, so on a user-auth mesh with no login on the machine, Ctrl-C on a foreground `cotal up --user-auth` or a bare `cotal down` exited 1 from inside the manager stop's agent inventory and left the manager, delivery daemon, user-auth service and broker running. The stop now prints `could not list managed agents (<reason>)` and finishes the teardown.
