---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

`cotal daemon` lines now name commands in backticks, so a Next or message wraps each command whole and `--json` carries the same text. `cotal daemon serve` prints one ready line, `daemon ready at <socket>`, on stdout; the duplicate `daemon: ready at` line on stderr is gone. `cotal daemon install`, `--dry-run` included, names what it read when it refuses outside a logged-in session: `USER` and `LOGNAME` when neither names a user, and `systemctl --user show-environment` when the user manager does not answer. Each refusal now has a Next. `cotal service install` gives the same user-manager refusal.
