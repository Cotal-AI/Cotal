---
---

The Hermes connector now supports `hermes-agent` 0.18 through 0.21 instead of pinning the 0.16 line, so the versions an operator can actually install are accepted. The launcher's check is a bounded range rather than an equality test on the major.minor string, and `pyproject.toml` declares the same range, because widening one of those alone leaves the other refusing what it resolves. Versions outside the range are still refused loudly, with an unreadable version treated as outside rather than waved through.

The gateway platform adapter accepts the keyword-only `is_reconnect` that `BasePlatformAdapter.connect` gained in 0.18 and that the gateway passes at every call site from then on, so a bumped pin no longer means a `TypeError` at platform connect after a clean plugin load. On a reconnect the bridge client is reopened, because `disconnect` latches its stop flag and leaves the reader thread finished, which would otherwise produce a platform that reports connected while receiving no mesh traffic.

`COTAL_HERMES_ADOPT_HOME` is a new opt-in that runs the gateway in your own Hermes profile instead of a disposable one, so a Hermes carrying your credentials and integrations can join the mesh. It installs only the connector's own plugin directory, reads your `config.yaml` without writing it, and leaves your `SOUL.md` alone. Enabling the plugin stays your decision, and a launch into a profile that has not enabled it fails with the settings to add.
