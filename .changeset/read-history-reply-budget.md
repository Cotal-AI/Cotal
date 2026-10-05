---
"@cotal-ai/core": patch
---

A `readHistory` page is now sized against the whole reply the delivery daemon sends, including the `ControlReply` around its items. `fitHistoryPage` charges that shell, and the daemon fits the page to the broker's `max_payload` as `maxPayload` reports it. Before, the items alone were fitted to 90% of `max_payload` while that headroom was documented as already covering the reply, so a page that filled the budget produced a reply larger than the budget it was checked against. A page can now use the full `max_payload`, and its reply never exceeds it.
