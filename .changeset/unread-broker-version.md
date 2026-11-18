---
"@cotal-ai/cli": patch
---

When `cotal up` cannot read the version of the nats-server it would start, it now reports a known failure and starts nothing, so a later `cotal down` has nothing to refuse. A first `up` under a low open-file limit on Node 24 used to fail `OPERATION_UNKNOWN` and leave an unconfirmed launch, and `down` then refused. It now fails `OPERATION_FAILED`, exit 5, with raising `ulimit -n` as the next step. Any other version check failure refuses `DEPENDENCY_UNAVAILABLE` and names its cause.
