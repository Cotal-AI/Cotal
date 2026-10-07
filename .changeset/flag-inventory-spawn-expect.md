---
---

The flag-inventory golden now lists `spawn`'s `--expect-owner` and `--expect-lifecycle-uid` flags, which the delegated-child lifecycle bootstrap added without updating the golden, so `pnpm smoke:flag-inventory` failed on `spawn`. This changes test tooling only; no published package changes.
