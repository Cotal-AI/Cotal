---
"@cotal-ai/cli": patch
---

`cotal clean store` and `cotal clean all` without `--store-dir` now read the store the root's last
broker served, as `cotal up` does. After `backup restore --store-dir` or an `up --store-dir` and a
plain `down`, they removed nothing and said "nothing to clean - no local state found" while that
store held the data and `up` refused and named it. While `.cotal/nats` holds no JetStream data and
that store does, they now remove it, and the dry run names it.
