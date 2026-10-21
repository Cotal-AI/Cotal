---
"@cotal-ai/cli": minor
"@cotal-ai/linear": minor
"@cotal-ai/web": minor
"@cotal-ai/workspace": minor
---

A Linear account with no record now refuses with `TARGET_NOT_FOUND` and the `cotal linear account add` route, in `linear account show` and when a `linear` service starts. The service refuses in its launch plan, so no child is started and no failed process exit is reported. A record that exists but cannot be read is still `DEPENDENCY_UNAVAILABLE`. The service checks the account in the Cotal home of the process that starts it, and refuses with `UNSUPPORTED` before a child when `COTAL_HOME` is unset and the definition's `envRefs` set `HOME` (on Windows, `LOCALAPPDATA` or `USERPROFILE`), because the child could read another home. A service adapter's launch hook now receives the definition's `envRefs` names, never their values. The endpoint name is checked when the service starts.

`cotal update --check` and the version read in `cotal update` run npm with a temporary cache that is removed afterwards, no log files and no npm update notifier, so they leave nothing in npm's cache, log directory or notifier stamp. From a source checkout, the `update --self` hint says it installs a separate global copy.

`service add --preset` offers no `--no-<option>` flag for a boolean option whose schema admits only true, so the web preset no longer lists `--no-read-only`. An absent `web` preset names `cotal ext add @cotal-ai/web` in its remedy. A background `service start` ends with the `service logs` command for the new instance. Re-adding an existing definition names the remove-and-add route, and an `ext remove` blocked by service instances names each one. A managed dashboard logs an endpoint error or warning by its class, the error's name and code, and never its message.
