---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

`cotal status` and `cotal endpoints` now date a presence row the way `cotal_roster` does. Both print how long the status has stood, such as `unchanged for 40m`, and the age of the activity, such as `(set 9h ago)`, and neither prints an age for a stamp that is not a finite number: `activeAt: "nope"` printed `active NaNd ago`, a `null` condition start printed an age counted from 1970, and `1e400` printed `active 0s ago`. Core exports `presenceAges`, which decides which facts a row dates, and `formatAge`, the one compact age formatter, so the CLI and the connector no longer keep separate copies.
