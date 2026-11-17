---
"@cotal-ai/core": patch
---

An `@` inside an email address or a path no longer counts as a mention. Before, `mail ana@example.com` sent a mention of `example.com` and could wake an agent of that name. `mentionsIn` now starts no mention right after an ASCII letter or digit, `_`, `.`, `-` or `/`, so every surface that posts typed text follows the same rule. A mention typed right after Chinese, Japanese or Thai text, as in `你好@rover`, still counts.
