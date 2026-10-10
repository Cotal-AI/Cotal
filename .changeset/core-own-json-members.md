---
"@cotal-ai/core": patch
---

Validate JSON object members as own properties in the Node compiler. This repairs five of the twenty observed Node conformance cases and adds public-export regressions and named mutation checks. The remaining fifteen cases and browser validation are not resolved by this change.
