---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

`cotal attach` redeems a session grant with the seed the mesh resolved, never one walked up from the current directory.

Resolution picks a root from the mesh registry and connects with it; redemption then asked the current directory the same question and used whatever it answered. The two disagree on a real machine rather than in theory, because root detection accepts any directory named `.cotal` and `~/.cotal` exists on every install (the mesh registry lives there). A command run anywhere under `$HOME` outside a project therefore minted its per-session credential from the home directory's trust chain and presented it to a broker that trusts a different one, surfacing as a bare authorization failure that named nothing. The trust material the resolution already carries is now used directly, which is the rule the control layer states for its own re-mints.

A cwd anchor holding a DIFFERENT chain for the same space is reported rather than obeyed: it cannot change what the command does, but staying silent about it is how the failure stayed a mystery. `@cotal-ai/workspace` gains `divergentCwdAnchor` for that comparison, which is silent on a second checkout of the same mesh and on a directory with no anchor at all.

The report cannot end the command either. Taking the seed from the resolution stops the current directory choosing which chain is used; it does not by itself stop it ending the run, because the report reads the walked root before the mint and the loader refuses unreadable trust material loudly. A half-written `.cotal/auth/broker.json` anywhere up the walk aborted an attach that had just declared it was not using that root, and on the reconnecting path that fault was retried as though the link were down. A fault reading either root is now reported as nothing to say, which is the accurate answer rather than a fallback: the comparison needs two legible chains, so an unreadable walked root asserts nothing and an unreadable resolved root leaves nothing to compare against. Corruption in the root the command actually reads still surfaces from the path that reads it.

When the resolved mesh genuinely holds no seed, the refusal now names what the command resolved: the broker and the root. The old sentence named neither the root nor the mesh.
