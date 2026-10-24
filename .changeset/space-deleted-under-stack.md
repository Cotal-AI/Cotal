---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/runtime": patch
"@cotal-ai/cli": patch
---

When a space's streams are gone from a broker that still runs, `cotal status` says so and names the
way back, and `send`, `history` and `run ps` refuse with that cause. On an open space that another
machine deleted under a running stack, status showed the space as reachable, `send` exited 3 with
"may have been stored", `history` reported an empty conversation and `run ps` printed a raw
contract-store error. Status now shows `Space streams: not on the broker` and leads its Next with
`cotal down --yes`, then `cotal up`, or with `cotal up` when the stack's other members are stopped.
The three commands refuse `TARGET_UNAVAILABLE` with the same remedy.
