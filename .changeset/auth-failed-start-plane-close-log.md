---
"@cotal-ai/auth": patch
---

A failed auth-service start now logs why its plane claim was not released. When the start fails after the authority plane opened and the claim release then fails (the row is no longer this plane's, or the broker is unreachable), the close failure goes to stderr, the same sink the plane already logs to. The start still throws its own error, and the row still stays held until the next start reclaims it through the liveness oracle. Before, that close failure was dropped and the held row had no recorded cause.
