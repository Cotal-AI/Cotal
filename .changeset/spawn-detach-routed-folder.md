---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal spawn -d` with no `--on` on a user-auth mesh now asks, in a terminal, which folder the agent
works in when the manager the exchange picks is on another host, as a launch with `--on` does. The
launch is pinned to that manager, so if it stops before you answer the launch is refused and goes
to no other manager.
