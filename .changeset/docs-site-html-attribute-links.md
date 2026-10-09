---
---

The docs site sync now rewrites the links and images a docs page names through HTML or JSX tags. An `href`, `src` or `srcset` that names a repository path follows the same rules as a Markdown link: an image is copied into the site and served from `/assets/`, a link to a published page goes to its route, and a link to an unpublished page or a missing file fails the sync. Before, such a target shipped as written, so the image was never copied and the link broke on the site. `check-dist` now also fails the build when a built page keeps a repository-relative `src` or `srcset`. This changes the docs site and repository tooling only; no published package changes.
