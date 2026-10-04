---
---

`pnpm check` now runs every step even after one fails, then lists each failed step with its exit status and exits 1. It used to be one `&&` chain, so the first red step ended the run and the output named only that step: a dead `:live` suite hid every step after it, and a red run looked the same whether it stopped at step 3 or step 30. A step that names no root script is refused before anything runs. This changes repository tooling only; no published package changes.
