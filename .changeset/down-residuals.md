---
"@cotal-ai/cli": patch
---

`cotal down` with several names now names a next step when one name matches no saved definition, the one a single named `down` gives: `cotal service` to list the saved definitions, or the web extension for `web`. For a broker name (`nats`, `broker` or `stack-broker`) it names a bare `cotal down`, which stops the broker with the whole stack, instead of `stack-broker`, which a set refuses. On a stack a plain `cotal up` started, `broker` among the names no longer says that no broker has been started.
