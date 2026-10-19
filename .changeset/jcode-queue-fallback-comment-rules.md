---
"@cotal-ai/connector-jcode": patch
---

The queue-fallback and host comments in the Jcode connector now state the rule the code keeps, in place of first-person accounts of how the change was written and reviewed. The published `queue-fallback.d.ts` no longer carries that narration in the documentation of `attributionBlockedByOpenRun` and `ExhaustedDeferralAction`. The deferral's documentation now says that the queue-fallback smoke grades it live, and the exhausted-deferral comment no longer claims that a spent recovery keeps delivering. No behavior changes.
