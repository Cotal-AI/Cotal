---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal feedback` now names the cause of an intake refusal and gives a next step. HTTP 401 says the key was refused, and points at `--key-file` or `COTAL_FEEDBACK_KEY`, or says the intake requires a key when none was sent. HTTP 404 says the URL has no feedback endpoint and names `<origin>/v1/feedback`. HTTP 429 says the intake is rate limiting submissions, with the retry time when its `Retry-After` header gives one. Before, all three printed the same sentence with no next step. The response body is still never echoed.
