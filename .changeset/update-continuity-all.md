---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal update` reports every running manager's continuity, and its refusal carries the remedy

With several meshes running and the shell outside every project root, the continuity check printed
the mesh resolver's bare text and exited before writing anything. It now renders that refusal through
the workspace renderer, the way every other command does, so it carries the `--space` / `cotal use`
recovery sentence. And because the install replaces the single `cotal-ai` that every running manager
shares, an unselected run now reports each running manager in turn instead of refusing, with any
`legacy` verdict making the whole run not a hot update. `--space`, `--server` and `--creds` still
select exactly one manager, and nothing is written until every selected manager has been observed.
