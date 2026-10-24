---
"@cotal-ai/cli": patch
---

`watch`, `chat` and `down` report output they could not write, such as stdout on a full disk, in one stderr line and exit 3, or with the non-zero status they had already set, as every other command does. Only a reader that closed the output ends them quietly. `chat --stdio` no longer says the reader closed stdout when a write failed for another reason.
