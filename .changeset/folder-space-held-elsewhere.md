---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A copy, a moved folder and a taken-over folder refuse again with another space selected

Since a folder's space became the target only while it runs, a copy of a project whose space runs
elsewhere, a folder moved away from its recorded path and the folder a later `cotal up` took the
name over from sent their reads to the selected space when one was selected, under a note to
restart the folder's space with `cotal up`, which refuses there. They refuse `TARGET_UNAVAILABLE`
again and name the folder or Cotal home the stack runs from, and bare `cotal` and `cotal space show`
there no longer offer that `cotal up`.

In a folder whose registered space is stopped, `cotal spawn -d --dry-run` now previews the space
`cotal spawn -d` launches on, and `cotal space show` calls that space stopped. Bare `cotal`, which
reads no broker, says the folder's space applies while it runs.

`--json` in a folder holding a prepared or stopped space carries the note under the `Mesh:` heading
as a `FOLDER_SPACE_NOT_RUNNING` warning, and `cotal chat` names the selection it joins with that
note. A refusal there whose own next step names `cotal up` no longer names a second one under its
heading.
