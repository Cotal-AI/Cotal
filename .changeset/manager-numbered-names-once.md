---
"@cotal-ai/manager": patch
---

The manager no longer reissues a numbered spawn name. Before, once `reviewer_2` despawned and its name was released, the next `reviewer` collision got `reviewer_2` again, so one name labeled two different agents in rosters and channel history. A numbered name is now issued once per manager process and a later collision takes the next number. Base persona names stay reusable, a hard-pinned `--name` is unaffected, and a restarted manager starts its record of issued numbers empty.
