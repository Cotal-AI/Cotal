---
"@cotal-ai/core": patch
---

Hold the identity and configuration a `CotalEndpoint` fixes at construction in one internal object that its parts read by reference, instead of passing each value to each part through its own callback. Point the internal parts' imports of `isPublishPermissionDenied`, `isFromSubjectSender`, `deliveryLimitOf` and `fitHistoryPage` at the modules that define them. The package exports, public methods and wire behaviour are unchanged.
