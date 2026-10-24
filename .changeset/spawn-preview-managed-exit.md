---
"@cotal-ai/cli": patch
---

A managed `spawn -d --dry-run` exits 0 with `completeness` `not-checked`, instead of exiting 4 with
an error mark. Both previews name the persona's source in words: `--file`, the command line, a
preference or the default. A harness that names no connector this workstation knows is now a
warning, `HARNESS_UNKNOWN`, or the `PREFERENCE_INVALID` warning `config` gives when only
`COTAL_DEFAULT_AGENT` chose it. The JSON source `explicit-or-product-default` is now `argument` or
`default`.
