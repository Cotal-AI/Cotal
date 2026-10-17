---
---

The PeerMesh, MeshFrame and MeshBanner header variants now build their horizontal bus paths with one shared `horizontalPath` helper. Each variant used to carry its own copy of the same loop, differing only in the bus row, so an endpoint or direction fix had to be made three times. The rendered frames do not change. This touches the `remotion/` asset project only; no published package changes.
