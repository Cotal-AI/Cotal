---
"@cotal-ai/manager": patch
---

The comment on the manager's first-start instance identity mint, which ships in `dist/manager.js`, now names hard-link publication as the exclusive create and states that a filesystem without hard links refuses the first start with `atomic-publish-unsupported`. It still named `link` / `O_EXCL`, which described the destination `O_EXCL` fallback that the create-only secret write no longer has. No runtime change.
