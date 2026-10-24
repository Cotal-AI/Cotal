---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`pinnedFetch` now throws its two refusals, a target that is neither https nor a loopback http literal and a redirect, as `PinnedFetchRefused`, exported from `@cotal-ai/workspace`, with a message that carries no `✗`. A transport failure still escapes as `fetch` throws it, and `assertPinnedFetchUrl` returns the same unmarked sentence. The CLI tells a refusal from a transport failure by that class instead of by the mark at the start of the message, and prints the same text as before. The registration policy refresh rethrows the fetch error as it is instead of stripping the mark.
