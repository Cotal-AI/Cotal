---
"@cotal-ai/core": patch
---

`isContractDigest` now accepts any value and is a type guard, and it returns false for anything that is not a string. It used to test its regex against the value's string form, so a one-element array holding a digest passed, and `parseReceipt` accepted a receipt whose `argsDigest` was such an array. The cluster, service, journal and remote-manager readers now call `isContractDigest` instead of keeping their own copies of the digest regex, so every core reader applies the same `sha256:<hex>` rule.
