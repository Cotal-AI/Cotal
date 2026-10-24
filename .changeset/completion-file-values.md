---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/runtime": patch
"@cotal-ai/cli": patch
---

`run start --file`, `run simulate --handler`, `auth mint --out` and `--identity`, and `--creds` on a
command with no completer of its own complete from the shell's file names. A flag declares that with
the new optional `FlagSpec.completion: "files"`. `spawn` completes the personas of a prepared space
that is not started, as `persona show` does.
