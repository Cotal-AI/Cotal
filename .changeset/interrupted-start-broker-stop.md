---
"@cotal-ai/cli": patch
---

A broker-only start killed after it recorded its broker's pid and before it registered its space no longer leaves a broker that `up` and `down` both refuse. The next `up` refuses `CONFLICT` with that broker's pid and `cotal down`, with or without `--server`, and `cotal down` stops it. Before, `up` called the broker "not started here", and an `up` without `--server` started a second broker on the same store at another port. `down` refused for lack of a registration.
