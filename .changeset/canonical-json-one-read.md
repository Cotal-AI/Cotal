---
"@cotal-ai/core": patch
---

`canonicalJson` and `contractDigest` now serialize a plain copy built during the I-JSON check instead of reading the value a second time. A Proxy whose later reads differ from what the check saw, or that answers `toJSON`, could pass the check and come back as text holding a lone surrogate, `null` for a checked number, or unsorted keys, and `contractDigest` hashed that text. The text now always encodes the data the check inspected. An array's length is read once, so a Proxy whose length changes during the copy can no longer add or drop an element, and a length that is not a non-negative integer is refused. Values that are already plain JSON canonicalize as before.
