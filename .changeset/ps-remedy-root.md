---
"@cotal-ai/cli": patch
---

When `cotal ps` refuses because no manager runs or is registered for the space, its next step now
names the root of this machine's own stack for the space, as bare `cotal up` in that folder. It used
to say bare `cotal up` with no folder, and run from another project that starts the other project's
manager. A space this machine only registered or records no stack for, or one reached through a
`--server` other than its recorded broker, gets a step that says to start the manager where the
space's stack runs and names no local command. `cotal status <agent>` and the `attach` picker share
the refusal. Its code, message, cause and exit 2 are unchanged.
