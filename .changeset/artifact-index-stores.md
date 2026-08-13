---
"@cotal-ai/core": minor
---

Give each space the two stores the artifact plane's bookkeeping needs.

Alongside the object store holding artifact bytes, a space now carries two small key-value stores:
one recording who produced which artifact, and one recording which channels an artifact has been
attached to. Both are created with the space and removed with it.

A space resource has to appear in five separate places — created, deleted, granted, listed for
backup, and rebuilt on restore — and being in four of them is the failure that reads as correct.
Both stores are in all five. The check that enforces this compares what the broker actually holds
against what the inventory declares, and it caught a first attempt that had added them everywhere
except the code that creates them.

Neither store is included in backups, for the same reason the bytes are not: an artifact does not
survive a restore, so rebuilding an index that points at bytes which were never saved would produce
records whose permission checks pass and whose content is missing. Restore recreates both empty.

Possession records carry no expiry, deliberately. A message can be delivered long after the agent
that sent it has been retired and replaced, and the record of who produced the artifact has to
outlive that agent for the delivery to still be accepted — an expiry here would quietly reject
legitimate deliveries that happened to arrive late.
