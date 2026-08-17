# @cotal-ai/lang

## 0.19.0

### Patch Changes

- 758e1e3: Pin `json-canonicalize` exactly, so a published install cannot resolve a broken tarball.

  `json-canonicalize@2.0.1` was published without the `bundles/` directory its own `package.json`
  `main` points at. A `^2.0.0` range therefore resolves, on any fresh install, to a package that
  cannot be imported: `cotal --version` crashes with `ERR_MODULE_NOT_FOUND` before printing
  anything.

  The repo never saw it. A lockfile pins 2.0.0 and CI stayed green throughout; a published package
  carries no lockfile, so npm re-resolves every range at install time and users got a version CI had
  never exercised. That gap between what CI resolves and what an install resolves is the actual
  defect this fixes.

  Both ranges are now exact, and `smoke:dep-pins` keeps them that way: it fails if either floats
  back to a range, and fails if its quarantine list stops matching any declared dependency, so a
  list that has quietly stopped applying cannot read as a list that holds.

  Stated as a limit rather than left implied: the new cell proves the range is exact, not that the
  pinned version is installable. Only installing the packed tarball against the live registry proves
  that, which is `smoke:seed-tarball:live` - and that suite sits outside `smoke:ci`, so the
  instrument that would have caught this incident exists and does not run. Wiring it into the gate
  is a separate decision about live-network tests in CI, not something this change makes quietly.

## 0.18.0

### Minor Changes

- df4d37e: Version `@cotal-ai/lang` with the rest of the workspace. It is a public package (`packages/lang`, alongside `core` and `workspace`) but was missing from the `fixed` group, so Changesets never bumped it: it stayed pinned at 0.15.0 while every other package moved, and `pnpm publish -r` would have pushed a version permanently out of lockstep with the release it shipped in. Joining the group means it versions and publishes with everything else.
