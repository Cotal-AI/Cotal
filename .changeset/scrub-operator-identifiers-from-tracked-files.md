---
"@cotal-ai/core": patch
---

Remove operator host names, space names and seat names from tracked comments and fixtures.

Twelve files carried the name of a specific deployment, a specific machine, or a specific
review seat inside comments, mutation descriptions and two test constants. The incidents they
record are the useful part and they are kept, with the identifier replaced by a neutral
description and the date left intact.

The two value changes are inert. `GSPACE` in the mesh-spawn grant block is a string handed to
the grant builder, and no assertion in that block reads it. The persona-frontmatter owner
fixture is changed at all five sites including the equality it is compared against, and the
suite reports 18 passed, 0 failed.
