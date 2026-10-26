---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/auth": minor
"@cotal-ai/delivery": minor
"@cotal-ai/web": minor
---

The manager and the built-in services start without being added first. `cotal manager start` starts the manager for this folder's or the selected space with the pty runtime and its registered broker, and `cotal manager stop`, `status`, `logs` and `restart` act on it; after `cotal up` it reports the manager `up` started and starts no second one. `cotal service` lists every built-in service, started or not, with the command that starts it, and `cotal service start <preset>` starts one from its defaults, refusing with the exact flags when it needs a file that has no default, such as the auth service's credentials. A service preset can declare those defaults: a literal, the space's registered root or broker, or a private file the space already keeps. `cotal service add <name> --exec "<command>"` adds a program of your own without a definition file, splitting the command into words without a shell and refusing pipes, redirection, variables and globs.

`cotal supervise` is deprecated again and is removed in 1.0.0 with the other daemon entries. It keeps its flags and behavior and prints one line on stderr naming `cotal manager start`, or, when it is given `--execution`, `--spawn`, `--seat-cap` or a resume flag that `manager start` does not take yet, saying to keep `supervise` for that run. `cotal manager install` refuses before any effect and names a unit of your own running `cotal manager start --foreground`. The `deliver`, `auth-service` and `feedback-intake` warnings now name `cotal service start <preset>`.
