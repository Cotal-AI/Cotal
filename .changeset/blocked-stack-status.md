---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A stack left blocked by an unconfirmed stop is now named the same way wherever it is reported. A `cotal down` interrupted after the member it signalled exited says that `up` and `down` refuse until `cotal down --abandon-stop <request-id> --yes`, and no longer offers `cotal down --yes`, which refuses there. `cotal status` in that folder while another space is selected shows the block under `This folder's space` with the `--abandon-stop` step first in Next. The note under the heading no longer says to restart a stack whose last `up` or `down` has no recorded outcome with `cotal up`, and names `cotal status` instead. With that space selected, `status` no longer ends with `run cotal up there to restart`.
