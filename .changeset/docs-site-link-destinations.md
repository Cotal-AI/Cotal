---
---

The docs site sync now rewrites only real link destinations. It parses each page as the site renders it, so a code span or a code example keeps its text, and a titled, angle-bracket or reference-style link reaches the site page, or is refused when it names an unpublished page. A link keeps its query and fragment, and a percent-encoded path names the same page. The sync now depends on `micromark` and `micromark-extension-gfm`. This changes the docs site and repository tooling only; no published package changes.
