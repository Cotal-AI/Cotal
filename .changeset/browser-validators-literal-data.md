---
"@cotal-ai/core": patch
---

`generateBrowserContracts` no longer refuses a valid schema whose string data reads like code, such as a `const` of `require(`, `eval(` or `new Function`. It now parses the standalone validator with acorn and refuses only an actual reference to `require`, `eval` or `Function`, or a call of a member with one of those names. Ajv runtime helper reads are rewritten from the same parse, and output that does not parse refuses.
