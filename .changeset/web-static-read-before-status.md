---
"@cotal-ai/web": patch
---

The dashboard's static route now reads a page file before it writes the status line. A missing or unreadable file used to be answered with `200`, `cache-control: no-cache` and an empty body, because the read failed after the status was already sent, so the browser ran an empty script and the page failed later with an unrelated message. It is now answered with the request handler's `500` naming the failed read. Successful responses keep their headers, and the session check still runs before the route.
