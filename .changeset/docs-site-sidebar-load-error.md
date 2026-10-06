---
---

The docs site's Astro config no longer turns a missing, malformed or unreadable generated sidebar into an empty navigation. The original read or parse error now stops Astro from loading the config. `npm run dev` and `npm run build` run the docs sync first and are unchanged; a raw `astro` command needs `npm run sync` before it. This changes the docs site only; no published package changes.
