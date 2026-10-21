---
"@cotal-ai/cli": minor
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
---

Settle a crashed or failed controller stack from process evidence instead of wedging its root. A bare `up` or `down` now takes the root's maintenance lock, records a member whose pid and start time are gone as failed, settles an earlier `up` or `down` that never recorded its outcome, and continues with an `OPERATION_SETTLED` warning. A live member is kept; a member whose process cannot be established, or one with an unconfirmed stop, refuses `LIFECYCLE_BLOCKED` with the exact `service status` command. Another holder of the lock is a known refusal that names its pid.

`down` is idempotent: a member already gone is recorded as stopped without loading its adapter or credential. `down --dry-run` exits 0 and lists members in stop order. When the manager is live but the broker is not, `down` refuses before any stop and names `cotal up --space <space>`, from a managed seat's shell too. A foreground `up` releases its terminal when another command stops the stack.

A first `up` binds the recorded broker address before launching, and a busy port refuses `CONFLICT` naming the address and bind error. A member that exits before readiness is recorded as failed with its exit code and log command. `space create` prepares a controller root again after a completed stop and `space forget`, so the remedy a refused `up` names works.

`ps` on a `--no-manager` stack refuses with a plain message. `status` shows a controller stack's members instead of legacy process rows and offers `cotal up --root <root>` when the stack does not answer. A legacy component name on a controller stack names its `stack-` member. The broker stop refusal names its dependants. `reset space` names the path that fails its scope check, and its receipt lists each path once. The manager's delivery-aware marker is written owner-only whatever the umask, never through a symlink and only into a file the user owns.
