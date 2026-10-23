---
"@cotal-ai/connector-claude-code": patch
---

A Claude plugin installation at local or project scope that its update does not reach no longer
blocks every Cotal command after an upgrade. Claude Code can apply `claude plugin update --scope
local`, run in a project folder nested inside another project with its own installation, to the
enclosing project and report the plugin as already current, so the nested folder's record stayed old
and the connector refresh failed on every command. The refresh now completes and prints a warning
that names the folder and the `claude plugin uninstall` command that removes the installation there.
A user-scope installation that does not update is still an error, and a failed update now names the
project folder.
