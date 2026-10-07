---
"@cotal-ai/connector-core": patch
---

`cotal_send` and `cotal_dm` now refuse a name they cannot verify with the presence-view condition `cotal_roster` and `cotal_orientation` print, read from one function. The two refusals used to spell the condition separately, as "the presence view is stale since T (Nms silent)" and "the presence view is unpopulated", while the roster and the orientation card said "the presence watch has been silent since T" and "the presence watch has not completed its initial snapshot". A stale view now reads the same in all four, without the elapsed milliseconds.
