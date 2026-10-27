---
"@cotal-ai/cli": patch
---

`cotal down` with several names now names a next step when one name matches no saved definition, the one a single named `down` gives: `cotal service` to list the saved definitions, or the web extension for `web`. For a broker name (`nats`, `broker` or `stack-broker`) it names a bare `cotal down`, which stops the broker with the whole stack, instead of `stack-broker`, which a set refuses. On a stack a plain `cotal up` started, `broker` among the names no longer says that no broker has been started.

`cotal manager logs` after `cotal down` of a plain `cotal up`, with the manager log removed, now says the log at its path is no longer there and names only `cotal up`, when a pid record of the dead manager or the instance identity a manager keeps in the folder shows one ran. It still refuses `TARGET_NOT_FOUND`, and says no manager has been started, naming `cotal manager start` as well, only when no such record exists.
