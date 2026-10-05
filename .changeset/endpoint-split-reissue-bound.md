---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

An agent's manager calls now repair a class-queue split as the CLI does. In a space with more than one manager, a call can reach a manager other than the one it resolved against, which refuses it before running it. `CotalEndpoint.invokeService` re-described and re-issued that call only once, and the re-issue splits again at the same rate, so with two managers about a quarter of `cotal_spawn` and `cotal_despawn` calls still failed. A spawn whose seat came up was reported as `Couldn't spawn` when the goal-result read that follows it split, and a named despawn was refused with `WAS NOT RUN`. The endpoint now re-issues up to 16 times, the bound the CLI already uses, which core now exports as `BIND_SPLIT_REISSUES`. A named `cotal_despawn` also asks its `inspect` lookup again when the manager that answered names a sibling instance as the owner, until the owner answers, within the same bound; before, it refused a live seat whenever the lookup reached the other manager.
