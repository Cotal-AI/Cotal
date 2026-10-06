---
"@cotal-ai/auth": patch
---

The issuing host now admits a run that a signerless manager forwards only if it saw the caller publish that `run-start` request on the broker, and only once. Before, it checked the forwarded subject's caller against live issuance and its publish ceiling, so a registered manager could get an admission, and then driver and mediator credentials, for any live caller whose ceiling permits `run-start` on it without that caller asking. The host's issuer connection now also watches the `run-start` request subjects on both manager routes, read-only, the way it already watched `run-resume` and `run-answer`. A forward it did not observe, or a second forward of one it did, is refused as `permission-denied`. The manager's request is unchanged.
