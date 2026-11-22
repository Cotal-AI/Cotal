---
"@cotal-ai/core": patch
---

Internal refactor: the endpoint's subscriptions, stream consumers, chat subscriptions, liveness responders, principal serves, durable-backstop channels, goal followers and DM-only handler live in one `DeliveryState` object that the endpoint's internal parts share by reference, replacing per-field getter and setter callbacks. No behaviour change.
