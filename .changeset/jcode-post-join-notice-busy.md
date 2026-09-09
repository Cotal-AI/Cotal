---
"@cotal-ai/connector-jcode": patch
---

Keep a Jcode seat alive when the model is busy at post-join.

The post-join mesh notice is sent with `noReply: true`, which routes through `requestOk` and
throws when the harness answers with an error frame. A model still busy at that moment refused
the notice and took the whole launch down, leaving a seat that had joined and then died. The
notice is now sent inside a try/catch that records the failure to the seat's connector log and
carries on, so a refused notice costs the notice and not the session. `noReply` stays on it: the
readiness assertion binds the request frame, which the harness logs before it replies.

Also repairs two shared jcode smoke guards that were latently broken and are only selected once
a change touches this suite:

- `jcode-model-refusals.json` declared a persistence mutation whose named red sat behind an
  earlier connector-log assertion, so it could never print. Removing the one shared write stops
  every diagnostic being persisted, so that mutation now names the first cell it actually
  reddens, and a second, narrower mutation drops only the startup fatal line's persistence while
  leaving its stderr copy, which is what proves the original per-seat claim.
- `provider readiness refusal names its code and rejected model parameter` matched the provider
  code and rejected model id anywhere in the host's stderr. The pre-join readiness diagnostic
  already contains both, so the cell passed with the classified render removed and could not show
  the suite reached it. It now also requires the classified line in the seat's connector log.
