---
"@cotal-ai/connector-core": minor
---

Make channel discovery and addressing feedback bounded and accurate.

`cotal_channels` now lists the channels a session is on or may join. It counts the agents' event channels and the channels outside the read ACL that it leaves out, and `all: true` lists them too. `filter` narrows the list by name. A reply lists at most 100 rows and ends with the `after` value that continues it. A live space had returned 656 rows in one 52 KB reply, 457 of them event channels.

`cotal_channel_info` describes an event channel as an agent's, and the session's own as its own, instead of as a name a prior send may have invented.

`cotal_dm` to the session's own name or id says that it names this session. A name that matches no peer in full lists the present names that start with it, so `ada` points to `ada (web)`. Nothing is sent and no name is ever picked for the caller.

`cotal_anycast` to a role nobody holds says that the request waits on the role's queue until an agent with that role takes it. The queue behavior is unchanged. `cotal_status` documents that a connector sets `working` and `idle` at turn boundaries.

The remote gateway now offers `cotal_docs`, which the orientation card recommends, and `cotal_connect` names the channels the new connection reads, may join and may post to.
