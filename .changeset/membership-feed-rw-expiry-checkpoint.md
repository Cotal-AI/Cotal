---
"@cotal-ai/core": patch
---

The membership feed's conn B now refuses to present an rw credential it has already decoded as
expired. The cached credential only ever advances through a preflight-proven adoption, so it cannot
hold an unproven generation, but a legitimately proven one expires as the clock advances. With
re-signing stopped, the broker closed conn B at the credential's `exp` and the client's own redial
presented the dead credential: an auth round trip that could only be denied, reported to the host as
the broker's "User Authentication Expired" rather than the local cause. The dial is refused before
it leaves the process, with separate messages for a feed that can renew and one that cannot, so the
diagnostic names the applicable remedy.
