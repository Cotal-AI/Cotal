---
"@cotal-ai/web": patch
---

The web-events-filter smoke now reads the by-name history route from its guard to the brace that closes it, and requires that body to both read the channel and return the page. Its window used to end at the first `}` after the guard, inside the read's options object, so a filter applied to the returned page left the suite green. No behavior changes.
