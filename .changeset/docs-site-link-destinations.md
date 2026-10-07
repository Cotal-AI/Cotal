---
---

The docs site sync now rewrites only real link destinations. It parses each page as the site renders it, so a code span or a code example keeps its text, and a titled, angle-bracket or reference-style link reaches the site page, or is refused when it names an unpublished page. A link keeps its query and fragment, and a destination written with percent-encoding, a backslash escape or a character reference names the page it renders as. The sync now depends on `micromark`, `micromark-extension-gfm` and `micromark-util-decode-string`. This changes the docs site and repository tooling only; no published package changes.
