---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`space create` and `up` no longer refuse a project folder that sits beside the records of a home `COTAL_HOME` redirects. 0.101.x treated every path under the Cotal home as its control directory, so the hosted layout, whose space root lives at `$COTAL_HOME/cotal`, could not start its broker and a cutover refused with `CONFLICT`. Under a redirected home only the home itself and its record entries (`meshes`, `prepared`, `services`, and the rest `homeRecordEntries` names) are control paths; the default `~/.cotal` still refuses every child, and a project's `.cotal` is unchanged.
