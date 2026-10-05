---
---

The shared `Card` backdrop behind the README card animations no longer takes a `frame` prop it never read, and its module drops an unused `useVideoConfig` import. The rendered cards do not change. This touches the `remotion/` asset project only; no published package changes.
