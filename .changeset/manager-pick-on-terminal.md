---
"@cotal-ai/cli": patch
---

With several of your managers live on a user-auth mesh, `spawn`, `ps`, `stop`, `attach`, `input`,
`models`, `persona` and `status` refused on a terminal too, so a plain `cotal spawn` could not run.
On a terminal they now ask which manager to use, with the most recently started first and as the
default, then run on the one you pick and say which one it was. A script, `--json`, `--no-input` and
`COTAL_NO_PROMPT=1` keep the refusal and its `--on` reruns.
