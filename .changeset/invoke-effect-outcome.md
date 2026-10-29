---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Carry the SPEC 13.3 effect outcome on `ControlReply` and in `cotal invoke` failure reports. `ControlReply` declares `outcome?: EpEffectOutcome`, and `controlReplyFrom` and `controlReplyFromThrown` preserve `error.outcome` and `EpEnvelopeError.outcome` when present. `cotal invoke` records `native: { code: "bad-request", outcome: "not-executed" }` on pre-publish input contract refusals and defaults an omitted outcome on an invocation failure or reply to `"unknown"`, so the report and JSON envelope state whether the call was `not-executed`, `executed`, or `unknown`.
