---
"@cotal-ai/core": patch
---

A presence observer now drops a bucket record whose `card.name`, `status` or `ts` is missing or has the wrong type, counts it in `presenceBindingDropCount` and reports it on the `warning` event. Before, a record with a non-number `ts` stayed live in the observer's roster after its key expired, because the staleness checks compared `NaN` with the liveness window. A record with a non-string `card.name` or a `null` value threw inside the presence watch loop, which ended the watch and surfaced as an `error` event.
