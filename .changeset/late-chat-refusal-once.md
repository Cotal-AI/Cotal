---
"@cotal-ai/core": patch
---

When the broker refuses a channel's live subscription after the join, for example because a config reload narrowed the user's permissions, `CotalEndpoint` now emits one `error` event for it instead of two. The `left channel "<channel>"` error carries the broker's refusal as its `cause`, and the status loop no longer reports the same refusal again as a permission denial. The status loop now skips only the refusal instances a channel subscription handled, so a refusal of a different subscription on the same subject is no longer hidden during a join's confirm window.
