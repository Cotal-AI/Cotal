---
"@cotal-ai/cli": patch
---

Sandbox `server-resolution:live`'s fixtures so a stray `.cotal` above the temp base cannot capture them.

`findCotalRoot` walks to `/` with no boundary, so one `.cotal` anywhere above the temp base captures
every fixture a suite mints there. This suite is unusually exposed: the whole premise of its `cwd`
fixture is that it has NO `.cotal` up-tree, so bare resolution falls through to the registry. Under a
captured base that premise is simply false.

Measured, both arms, against a deliberately poisoned base: unconverted, the suite resolved against a
foreign registry and dialled the shared local demo broker instead of its own fixture. Converted, it
rejects the captured base, mints under a clean one, and passes its 18 checks. The scratch is
witnessed with `assertScratchHeld` rather than assumed, which is the half that makes it evidence.

Only this one entry is converted. The other live entries mint raw too, but minting raw is not the
same as being captured: tested by artifact, two of four write into a captured root and two never
touch it. A sweep would have "fixed" suites that were never broken, so the rest want the
poisoned-base arm run per suite first (tracked on #360).
