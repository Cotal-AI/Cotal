---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Telemetry counts a person once. The settings file with the install id now lives in the OS user's own Cotal directory (`~/.cotal/telemetry.json`, or `%LOCALAPPDATA%\Cotal` on Windows), which `COTAL_HOME` no longer redirects, so every workspace one person runs under their own account reports the same install id instead of a new one per `COTAL_HOME`. At `regular`, the `command` and `install` events carry a new `account` field: a sha256 hash of the IdP URL and subject id of the home's cached sign-in, cut to 32 hex characters, so one person on several machines counts once; the id itself is never sent, and the field is `null` without a sign-in. `cotal telemetry` reports the hash. A level set earlier in a `COTAL_HOME` file is not read any more; set it again with `cotal telemetry <level>`.
