---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal spawn` handles a name that is already taken. When a live manager of yours runs that agent,
or presence or the mesh reports it online, the spawn launches nothing, says where it runs and exits
0; in a terminal it attaches to that agent, and otherwise it prints the `cotal attach` command. When
the mesh answers that the name is held by a lifecycle that does not run, the spawn releases that one
lifecycle by its UID with your login and asks again, waiting up to 2 minutes while the mesh says the
name is still retiring. This applies to managed launches and to spawns in this terminal; an
implicit name is numbered past an online holder only. The auth client keeps a host's typed HTTP 409
answer (`AGENT_LIFECYCLE_HELD`) and passes it through the manager. The stock auth service answers
409 for its own conflicts, which the CLI now reports as `CONFLICT`, and a manager's refusal of a
hard-pinned name it holds carries `already-exists`. `cotal auth retire <uid>` releases a lifecycle
on such a mesh. A failed agent provisioning now says its outcome is unknown instead of calling it
refused.
