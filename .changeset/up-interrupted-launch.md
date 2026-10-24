---
"@cotal-ai/cli": patch
---

An `up` killed after it recorded a member's launch and before it recorded the child no longer
leaves the root refusing every `up` and `down` with no way out. A detached `up` interrupted by
SIGINT, SIGTERM or SIGHUP in that window records the launch on its way out, as `failed` when no
child was spawned yet or with the child's process when one was. After a SIGKILL or an out-of-memory
kill, the refusal names `cotal down --abandon-launch <instance-id> --yes`, which records that member
`failed` with a `LAUNCH_ABANDONED` warning, since a process the launch started without recording it
is not excluded, and stops the rest of the stack.
