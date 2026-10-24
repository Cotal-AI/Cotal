---
"@cotal-ai/cli": patch
---

An exec-endpoint service whose host process died without removing its registration still refuses
to launch that instance again, and the refusal now says so. It names the earlier host's pid and its
native registration, and its Next gives the `cotal endpoint deregister` and
`cotal service start <name> --new-instance` commands. `service restart` of that instance gives the
same commands.
