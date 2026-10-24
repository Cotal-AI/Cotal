---
"@cotal-ai/cli": patch
---

When a service the user added still runs in a space, `cotal space delete` now names that service and
the `cotal service stop` that stops it. Its Next used to name `cotal down --yes`, which refuses while
that service runs. With only the broker left after the stop, it names the delete again.
