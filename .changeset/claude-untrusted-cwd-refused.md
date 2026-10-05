---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-claude-code": patch
---

A supervised Claude seat whose directory the manager host's own Claude does not trust is now refused before it launches, with an error that names the directory and Claude's workspace-trust dialog. Claude opens such a directory on that dialog, whose default answer exits, so the seat used to die on launch with only `EntertoconfirmEsctocancel` as its last output. Trust is read as Claude reads it: a parent directory's trust counts up to the root of the directory's own Git repository, and a linked worktree shares its main checkout's trust. The manager passes the seat's directory to the connector as the new `LaunchOpts.cwd`, so a spawn, a supervised restart and a preserved-seat resume are all checked. A foreground `cotal spawn` still shows the dialog in the operator's terminal. A carried resume uses the same check.
