---
"cotal-ai": minor
---

Add `cotal daemon setup`, one command that connects a headless machine to a space.

It installs the daemon as a systemd user service, waits for it to answer, signs it in by device code when it is not signed in already, asks the space to register it, and connects it once the space owner approves. No local browser is needed anywhere on that path: the sign-in prints an approval link and code to open on another device. It prints one plain line per stage to stderr, so `--json` still writes one document on stdout.

Every stage is skipped when it is already done, so running it again after an interruption continues rather than starting over. `--wait <seconds>` bounds the wait for the owner's approval, 900 by default, and `--wait 0` reports what it reached. A wait that runs out is a partial that says the service is installed and the registration is sent, so a rerun continues. An answer that cannot improve is a refusal carrying the space's own reason, and the connection stage is never reached. Only a connected machine exits 0.

A daemon already answering while no installed unit is recorded for it refuses `CONFLICT` (`RUNNING_WITHOUT_UNIT`), because installing then would start a second daemon that the lifetime lock refuses and the running one is not a persistent service. Pausing, renaming and disconnecting stay their own commands.
