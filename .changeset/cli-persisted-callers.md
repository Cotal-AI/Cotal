---
"@cotal-ai/workspace": minor
"@cotal-ai/manager": minor
"@cotal-ai/delivery": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
---

Deprecate the daemon entries `supervise`, `deliver`, `auth-service` and `feedback-intake`. Each keeps its existing flags for units, scripts and containers written for earlier releases, help and completion no longer list them, and every run prints one stderr line naming its service preset (`manager`, `delivery`, `auth-service`, `feedback-intake`) and the release that removes it, `1.0.0` for all four. `deliver pending` warns the same way and names `cotal pending <agent>`. Stdout, behavior and exit codes are unchanged. The top-level `feedback-intake` entry runs again with its existing flags instead of refusing. `up` now starts its manager, delivery daemon and auth service through hidden twins of `supervise`, `deliver` and `auth-service` with the same flags and runner and no warning, so only a unit, script or container someone can change prints it. The process checks that recognise a running manager or delivery daemon accept the twins' command lines too.

Background `cotal up` that is the main process of a systemd unit now names that unit and the `--foreground` remedy on every route it takes, including the controller-owned stack and a refresh of a running stack. It still changes no mode and no unit. A foreground run, a dry run and `up -f` print nothing.

The `solo` container in `deploy/` runs `spawn scout --foreground`. `docs/UPGRADING.md` gains the persisted-caller section: the command mapping, the deprecated entries and their removal release, the literal `up --foreground` replacement for systemd and launchd callers, the owned-unit and downgrade notes, and the container change.
