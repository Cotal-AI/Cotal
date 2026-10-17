---
"@cotal-ai/core": patch
---

`cotal down -f` on an authenticated mesh now removes the channels its run owns. The `teardown` credential it mints could not read the membership feed, so the check for other members always failed and every owned channel was kept with `membership unknown (no feed)`, ending in `! partial teardown` with exit 1, and `down -f --run <id>` could never finish the run. The credential now holds the feed's read verbs and still cannot write it. A channel another member still uses is kept as before.
