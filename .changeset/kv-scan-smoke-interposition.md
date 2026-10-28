---
"@cotal-ai/core": patch
---

The kv-scan smoke now routes its push-consumer interpositions through one `withPushConsumer` helper typed from the client's `PushConsumer` and `Bucket` seam instead of repeating the `js` cast and `Object.defineProperty` wrapper in each cell, and the rotation check requires the interposed reset to have recorded the rotated consumer name. Shipped behaviour is unchanged.
