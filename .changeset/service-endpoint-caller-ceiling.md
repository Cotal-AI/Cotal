---
"@cotal-ai/auth": patch
---

`cotal service-endpoint approve --caller-ceiling <capabilities>` now works. Each named capability becomes a ceiling entry, pinned to the proposed instance, for every proposed command that declares it. Before, the names were sent as bare strings and the host refused every approval that carried a ceiling with "endpoint caller policy: expected an object". A capability no proposed command declares, or one a targeted command declares, is refused before anything is sent.
