---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

On a terminal, a bare `cotal spawn` on a user-auth mesh where several of your managers are live
asks where the agent runs: this terminal, the default, or one of those managers, which launches it
and attaches here as `--on` does. A managed launch on a manager that is not known to run on this
host, picked or named with `--on`, then asks which folder the agent works in unless `-C` names one.
Enter keeps the manager's workspace and sends no folder. A typed folder is sent as typed and checked
by that manager with `resolve-cwd` before anything is launched; a folder it refuses is asked again.
No manager credential is held while a question waits. `--json`, `--no-input`, `COTAL_NO_PROMPT=1`
and a missing terminal never ask.
