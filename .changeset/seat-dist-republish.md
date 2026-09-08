---
"@cotal-ai/seat": patch
---

Republish `@cotal-ai/seat` with its compiled `dist/`.

The 0.47.0 tarball was produced by the emergency bootstrap path before the workspace build had
run, so it shipped `package.json`, the README, the licence and the two native helpers, and no
`dist/`. Its export map targets `./dist/index.js`, so `@cotal-ai/manager` fails at load and the
`cotal` binary does not start. npm does not allow replacing a published version, so the working
distribution ships as a new one.

This carries no source change. `ci:publish` builds the workspace before packing, so the
republished tarball contains the declared entrypoints.
