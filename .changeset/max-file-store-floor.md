---
"@cotal-ai/cli": patch
---

`cotal up --max-file-store` accepted any positive integer, but the space's membership bucket reserves 64 MiB of the broker's file store, so a smaller cap failed the start with a bare JetStream code 10047 and no cause. That cap then stayed recorded: `up` with another `--max-file-store` refused `CONFLICT` even after `cotal down`, and no reset or clean cleared it. A cap below 67108864 bytes now refuses `USAGE_INVALID` before anything starts. A stopped stack's next `up --max-file-store` replaces the recorded cap, as the docs already said, while a running broker keeps its own. When stream setup fails for want of storage, the failure names the cap and `cotal up --max-file-store <bytes>`.
