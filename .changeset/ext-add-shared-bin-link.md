---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

`cotal ext add` no longer fails with `EEXIST` on `node_modules/.bin` when the new extension installs a bin link that the extensions prefix already has, for example a dependency shared with a seeded connector. Node's `fs.cpSync` refuses to copy a symlink onto an existing one, so the add now removes each link it is about to replace before it promotes the staged install.
