---
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
---

The manager carries an agent's MCP server selection as a list instead of the `--share-tools` flag string. The CLI parses `--share-tools` once and sends the list, so the `spawn` operation's `shareTools` input is now an array of server names and the manager cluster document moves to revision 22. A `supervise --roster` entry's `share-tools:` list is used as written, so a declared server named `none`, or one whose name contains a comma, now loads and is shared instead of refusing the roster. Preserved-state inventories are written as `cotal-manager-resume/v2`; a v1 inventory from an earlier release still resumes.
