---
"@cotal-ai/auth": patch
---

Token reads that remain rate-limited now expose the provider's retry timing in a typed error.
`IdpRateLimitedError` carries HTTP status 429 and an optional `retryAfterSeconds` from the final
response, without adding retries or inventing a delay when neither retry header is usable.
