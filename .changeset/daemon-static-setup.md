---
"cotal-ai": patch
---

Machine service setup now refuses local static-auth and open spaces before turning them on or saving a hosted Manager refusal. Setup, service status and disconnect explain that these spaces run their Manager under `cotal up`, instead of suggesting commands that cannot connect them to the machine service. Status corrects the guidance on older saved refusals without rewriting them. Damaged mesh records report unavailable service status without stopping the daemon or losing its overall status, and do not block cleanup of a local refusal with no Manager registration.
