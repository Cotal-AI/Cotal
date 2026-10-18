---
"@cotal-ai/delivery": patch
---

`cotal deliver --space <s> --dev-mint` now signs its dev cred with space `<s>`'s account. It used to pick the root's only space, so a root holding several spaces refused a correct `--space`, and a root holding one other space signed the cred with that space's account. A root with no account for `<s>` is now refused before any dial.
