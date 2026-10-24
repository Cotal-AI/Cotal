---
"@cotal-ai/cli": patch
---

After a foreground `up` lost its terminal, or a `down` was killed, while it stopped the broker or the delivery daemon, `up` and `down` refused until that stop was abandoned with `cotal down --abandon-stop <request-id> --yes`, but `status` offered `cotal up --root <root>`, which refused. `status` now says why the stack is blocked, names the member, and offers the same `--abandon-stop` command and the member's `service status`. `status --json` carries it as `folder.stackBlock`.
