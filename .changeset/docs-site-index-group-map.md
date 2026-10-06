---
---

The docs site sync now refuses when the docs index and the site's group map list different pages, and names the page that is missing from one of them. It reads the links of the rendered index as a browser does, so an HTML link or a character reference counts, a link in a code example or an HTML comment does not, and a query, a fragment or percent-encoding leaves the page the same. Design notes under `docs/design/` and the `spec/` references stay on GitHub and are not compared. The site also publishes Authoring a connector in Guides, after Connect pi, where the index already lists it. This changes the docs site and repository tooling only; no published package changes.
