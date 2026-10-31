---
"@cotal-ai/connector-core": patch
---

Load bundled documentation from an inline gzip payload on first use to reduce idle connector memory. Keep the synchronous docs API and existing plugin assets unchanged; decoding adds temporary memory and work to the first docs call.
