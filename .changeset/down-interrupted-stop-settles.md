---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
---

A controller stack no longer stays blocked after a `cotal down` exits partway through a member's stop, for example because it was killed or its terminal closed. A manager stop that the dead `down` had not yet handed to the manager is settled by the next bare `up` or `down`, and the stop reservation that `down` left is released once its pid has exited. A reservation held by a live process is refused with that pid named. A broker or delivery daemon that the dead `down` left `stopping` is named in the refusal with `cotal down --abandon-stop <request-id> --yes`, which now takes that stop once the process is gone. Before, every `up`, `down`, `--abandon-stop` and `service stop` refused.
