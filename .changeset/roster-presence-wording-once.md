---
"@cotal-ai/connector-core": patch
---

`cotal_roster` and `cotal_orientation` now read the presence trust condition from one function, so they print a stuck presence writer, an unpopulated view and a stale view in the same words. The roster used to spell the stuck-writer preface separately for an empty and a populated roster, a stale empty roster said "the rows below are last-known" above "No one is present", and the orientation card left out the stuck writer's recovery clause and the unpopulated view's "a missing name is not an absence verdict".
