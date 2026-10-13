---
"@cotal-ai/auth": patch
---

`cotal up --user-auth --idp <url>` on a space that already pins an IdP now compares the normalized URL with the pin. Re-running the command that created the pin with a trailing slash was refused as a re-pointed IdP that "would re-key every derived owner", although both spellings name the same IdP. A malformed later value now gets the same URL refusal as a first enable, and a different IdP is still refused.
