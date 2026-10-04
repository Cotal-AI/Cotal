---
---

The flag-inventory golden now lists `run`'s `--json` flag, which `cotal run ps` and `cotal run journal` gained without the golden being updated, so `pnpm smoke:flag-inventory` failed on `run` and stopped its CI shard before most of that shard's suites started. This changes test tooling only; no published package changes.
