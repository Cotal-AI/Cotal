---
"@cotal-ai/cli": patch
---

When the broker's log shows that it disabled JetStream after its store refused a write, as nats-server does for a permission or space error, `cotal down`, `cotal service stop stack-manager` and `cotal up` now refuse `DEPENDENCY_UNAVAILABLE` before any stop or start and name the logged failure, where they ended `OPERATION_UNKNOWN` "timeout" with no next step. Their next step, and `cotal status`, name the way out: end the manager on the stack's host with `kill -TERM <pid>`, run `cotal down`, fix the cause, then `cotal up`. `cotal down --dry-run` names the refusal. The next step of `send` and `status` for a store write failure now names the fix for the logged cause, such as write access for a permission error, instead of always freeing disk space, and `status --json` reports `store.jetStreamDisabled`.
