---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"@cotal-ai/runtime": patch
"@cotal-ai/manager": patch
---

A stopped space's last operation now names its command in backticks, as in "its last operation, `cotal down`, completed", so `status`, `use`, `space` and `space show` no longer split it after `cotal`. With a 36-character space name, `status` at 80 columns broke inside `cotal down`, and `use` broke the same way at 40 columns. `--json` carries the same text, so `lastOperation` and the selected space's `message` now hold the backticks. The `--on` help of `run` and its `start`, `show`, `answer` and `amend` verbs, and the refusal for a malformed `--on`, now write `` `cotal ps` ``, and the `--launch` help of `supervise` writes `` `cotal up -f` `` and `` `spawn -f` ``.
