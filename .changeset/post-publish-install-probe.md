---
---

ci: add post-publish installability probe to the release workflow

After `ci:publish` lands tarballs, a new `install-probe` job packs the workspace
`cotal-ai` package, extracts the tarball, verifies the bin entry exists, and runs
`cotal --version` and `cotal --help` from the packed binary. A broken tarball or
a version mismatch reds the job, surfacing packaging defects as a CI red on the
overall workflow. `install-probe` is a leaf job that runs after `version` completes,
so `gh release create` has already run by then; it does not gate the GitHub Release
(which is gated by the closure gate from #1502). It validates the shape of cotal-ai's
own packed artifact (structure, binary presence, startup). It does not pack the sibling
workspace packages, so their packaging is not exercised, and it does not cover
registry-side propagation or native-asset loading.

Refs #1412
