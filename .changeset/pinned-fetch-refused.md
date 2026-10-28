---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A pinned fetch that the policy refuses, a target that is not https and not a loopback http literal, or an answer that is a redirect, now throws `PinnedFetchRefused` with an unmarked message. A transport failure still escapes as whatever `fetch` threw. `meshes add`, `meshes add --from` and `space add --from` tell the two apart with `instanceof` and add `✗` where they print, instead of sniffing the glyph in the message. The policy refresh no longer strips that glyph before rethrowing.
