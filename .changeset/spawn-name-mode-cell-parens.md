---
"@cotal-ai/core": patch
---

The spawn-name smoke's auth-mode cell now looks through parentheses before it checks the door's mode argument. Writing the call as `(target.mode === "user")` or parenthesizing either operand used to fail the cell although the CLI behaves the same. A `!==` comparison, a bare `true` and swapped arguments still fail it. No behavior changes.
