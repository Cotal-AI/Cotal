---
"@cotal-ai/cli": patch
---

fix(cli): re-offer the global install on a repeat `npx cotal-ai setup`

`offerGlobalInstall` only ran on the first-run path (`runFirstRun`). The onboarded marker
(`~/.cotal/onboarded.json`) is written once, so every later `cotal setup` routed to `runEnsure`,
which never offered the install. Any machine that had already onboarded — declined or failed the
install the first time, or onboarded before the offer existed — could re-run `npx cotal-ai setup`
forever and never get a durable `cotal` on PATH. `runEnsure` now runs the same offer, gated by the
same `isNpx()` + PATH scan, so it's a no-op for a dev clone or an already-installed `cotal` and only
fires for the npx-without-`cotal` case it's meant to fix.
