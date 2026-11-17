---
"@cotal-ai/web": patch
---

The dashboard session cookie is now `SameSite=Lax`, so a link to the dashboard on another site, such as a homepage tile, opens it in the browser profile that exchanged the launch link. With `SameSite=Strict` that navigation answered 401 `unauthenticated`. Another site's fetches and POSTs are still refused with 403 `cross-origin`, and the browser does not attach the cookie to them.
