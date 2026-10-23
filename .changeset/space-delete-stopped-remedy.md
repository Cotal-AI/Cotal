---
"@cotal-ai/cli": patch
---

`space delete` of a stopped stack now names `cotal reset store <space> --yes`, which removes its stored
streams, and `space forget`. Before, it said to start the space and delete it then, which meets the
running-stack refusal again. A prepared space that never ran names only `space forget`. The
`--dry-run` warning on a running stack no longer says that no broker was contacted.
