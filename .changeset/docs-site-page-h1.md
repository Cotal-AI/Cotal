---
---

The docs site sync now reads each page's title from the H1 the page opens with and drops that same heading from the body. Before, it took the first line anywhere in the file that started with `#`, including a shell comment inside a code fence, fell back to the file name when there was no H1, and left the H1 in the body when anything preceded it. A published page that does not open with an H1 now fails the sync with an error naming the page. This changes the docs site only; no published package changes.
