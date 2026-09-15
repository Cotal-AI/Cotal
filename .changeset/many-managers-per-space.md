---
"@cotal-ai/manager": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Many managers per space, on the same device or different ones

A space has many managers. Since the #773 fix, a manager refused to start unless its SecretStore
was the one the delivery daemon reloads from, which on an auth-mode space meant one manager per
space, on the daemon's host, from the daemon's root. A second manager on a laptop, or a second
root on the same machine, was impossible.

The manager now classifies the daemon's reload store instead of refusing it. A manager whose store
is the daemon's is the daemon-cred renewal owner and remints as before, with fingerprint-only
adoption. A manager whose store is foreign starts, serves seats, never remints daemon creds (a
generation written where the daemon cannot read it was the original #773 defect), and records in
its renewal record that renewal is owned elsewhere, naming both stores. `cotal doctor auth` renders
that as owned elsewhere, not as a problem. A hung or unreadable store challenge skips the pass and
records why; it never remints on an unproven relation.

`smoke:manager-two-root-renewal` now proves the two-root composition starts, reminted nothing into
either root, and recorded the owner-elsewhere note; its control phase still proves the unified root
adopts.
