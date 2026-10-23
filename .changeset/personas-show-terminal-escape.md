---
"@cotal-ai/cli": patch
---

`personas show` on a terminal now escapes control characters in the persona file, as `persona show`
does. Piped or redirected, it still writes the file byte for byte.
