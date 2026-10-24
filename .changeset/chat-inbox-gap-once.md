---
"@cotal-ai/cli": patch
---

`chat` reports a full inbox as one `inbox` gap with the number of messages it dropped, instead of
one gap per dropped message. A channel replay past the 500-message inbox now prints one line.
