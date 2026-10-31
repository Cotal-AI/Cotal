---
"@cotal-ai/workspace": patch
---

The comments in `space-segmentation.ts` now name the code they cite. Every one of them cited a line number that had drifted onto unrelated code. The absent-means-mint writer is named as `healMembershipDataCreds` in the CLI's `up` command. The `provisionMembershipCreds` note now says it hardens the per-space directory, which it has done since the kinds moved to per-space resolvers. No behavior changes.
