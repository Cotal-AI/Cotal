---
"@cotal-ai/core": patch
---

`spaceBackupInventory` now checks that its backed-up and excluded lists classify exactly `spaceDeletionStreams`, the set `deleteSpace` removes and the teardown grant names, and throws when they differ. The backup inventory and the deletion set were two hand-kept lists, and nothing compared them. They agree today, so no inventory changes.
