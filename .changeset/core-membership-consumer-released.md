---
"@cotal-ai/core": patch
---

Membership-watch consumer cleanup now recognizes missing streams or consumers only from structured JetStream API errors. `membershipConsumerReleased` now checks `isJetStreamMissing` for `ConsumerNotFound` and `StreamNotFound` alongside `isPublishPermissionDenied`, instead of accepting an arbitrary `404` status code or matching `"not found"` in an error message.

