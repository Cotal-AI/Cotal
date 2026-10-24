---
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
"cotal-ai": patch
---

A refusal of a value that names its own fix no longer prints the command's whole help after it. An
`--on` that is empty, a principal id or not an instance id, a `spawn --on` that needs a terminal or
`-d`, `attach` with no name and no terminal, and a `run` command given no run id now print the
refusal and its next step only. The `run` refusal names `cotal run ps`, or `cotal run turns` for
`yield`.
