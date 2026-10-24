---
"@cotal-ai/cli": patch
---

After a first `cotal up` that launched no member, such as one refused because another program holds its broker address, the next `up` may ask for `--open` at another address, as the docs say. It used to refuse "pinned to static auth" and name a bare `cotal up`, which reused the held address.
