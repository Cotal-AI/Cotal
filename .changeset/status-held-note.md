---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal status` run in a folder whose stack is blocked by an unconfirmed stop, while another space is selected, no longer opens with a note that says to run `cotal status` there. It shows the block under `This folder's space` with the `--abandon-stop` step first in Next, and its `--json` no longer carries that note as a `FOLDER_SPACE_NOT_RUNNING` warning. Other commands run there still head with the note, which names `cotal status`.
