---
---

The website's post-build check now reads link targets from parsed pages instead of matching text. It used to match a list of seven repository prefixes against the raw text of every built page, so a code sample that showed a relative link failed the build, and a relative target outside the list, such as `assets/x.png` or a sibling page, passed. It now parses each HTML page, Markdown twin and llms set the way the docs sync parses them and refuses any `href`, `src` or `srcset` URL or Markdown link destination that resolves against the page's own path. The sync and the check share one module for how a target is classified. This touches the `website/` project only; no published package changes.
