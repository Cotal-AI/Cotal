---
"@cotal-ai/core": patch
---

Clean up each finite KV scan's owned consumer on completion, interruption or cancellation, while retaining the broker's inactivity expiry as a crash backstop. Preserve cancellation through empty-scan bind and cleanup, including calls with an omitted filter, instead of returning an empty result. Membership-feed reconciliation now reads live entries in one scan.
