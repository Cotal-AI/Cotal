---
"@cotal-ai/connector-hermes": minor
---

Hermes seats now accept an initial prompt, so `cotal spawn --prompt`, a manifest `prompt` and an ACP client's first message start a Hermes turn. The launcher hands the text to the gateway once, as the user's own words, in the adapter's `operator` chat. That chat has no mesh target, so the reply shows on the seat's event plane and is not posted to the mesh.
