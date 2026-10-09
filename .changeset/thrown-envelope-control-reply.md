---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A manager call that fails with a thrown envelope error now returns the error's code and details, the same as a refusal that arrives as a reply. The CLI's control calls, `cotal spawn -f` and the connector's manager tools each converted the thrown error by hand and dropped the code, and two of them also dropped the details and the lifecycle-blocked suffix. A `cotal attach` reconnect therefore kept retrying a `permission-denied` or `not-found` raised on the caller side, such as a broker refusal, instead of stopping on it. Core now exports `controlReplyFromThrown`, and each caller keeps its own message.
