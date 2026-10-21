---
"@cotal-ai/cli": patch
---

`cotal down --space <name>` with no service name now refuses with `USAGE_INVALID`, exit 1. Its remedy is a bare `cotal down` from the stack's root, or `cotal service stop <service-name> --space <space>` for one saved service. It used to exit 3 as `OPERATION_UNKNOWN` and point at `cotal down web --space <name>`, which is now a service stop. On a root without a controller stack, `cotal down --yes` now says that `--yes` applies only to a controller stack and that a bare `cotal down` stops this root's stack without it. `--json` and `--plain` on a bare stop say the same in their own refusal. Both still refuse and stop nothing. `cotal ext remove` no longer advises `cotal down <component>` for a running extension process, because a named `down` is a service stop. It names the pid to stop, or the dead process's pidfile to delete. The component-selection code that `down` could no longer reach is removed.
