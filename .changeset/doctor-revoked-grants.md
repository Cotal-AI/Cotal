---
"@cotal-ai/cli": patch
---

`cotal doctor auth` names the read and post channels and the role of a revoked or other-account agent file in the mint it gives for a new key, such as `cotal auth mint wer --allow-subscribe general --allow-publish general --role rev --out <new file>`. Before, the mint named the label alone, so the new key it wrote could read and post nothing.
