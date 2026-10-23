---
"@cotal-ai/cli": patch
---

`personas list` and `personas list -v` now escape control characters in the persona names, roles,
models, descriptions and bodies they print, as `persona show` does. `persona create` and
`personas new` refuse a `--role` or `--model` that holds control characters.
