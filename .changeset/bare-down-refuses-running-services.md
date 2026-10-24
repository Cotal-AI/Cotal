---
"@cotal-ai/cli": minor
---

Bare `cotal down` on a legacy root now refuses `LIFECYCLE_BLOCKED`, before it stops anything, while
a saved service in the space still runs or cannot be verified, as a controller stack's `down` does.
The refusal names each one with the `cotal service stop` that stops it, then `cotal down` again, and
a stopped service does not block. It used to stop those services itself first, under the one
`down`, with no confirmation of their own. The dry run warns with that refusal, and its JSON lists
the instances as `serviceChecks` in place of `serviceStops`. This is a behavior change; see the
upgrading guide.
